import * as hre from 'hardhat'
import {
    impersonateAccount,
    setBalance,
    setNextBlockBaseFeePerGas,
    time,
} from '@nomicfoundation/hardhat-network-helpers'
import {
    Anyrand,
    AnyrandConsumer,
    AnyrandConsumer__factory,
    AnyrandHarness,
    AnyrandHarness__factory,
    DrandBeacon,
    DrandBeacon__factory,
    Dummy__factory,
    ERC1967Proxy__factory,
    GasStationEthereum,
    GasStationEthereum__factory,
    ReentrantFulfiller__factory,
    ReentrantRequester__factory,
    RevertingCallback__factory,
    WhateverBeacon__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { Wallet, ZeroAddress, keccak256, parseEther, parseUnits, randomBytes } from 'ethers'
import { expect } from 'chai'
import { bn254 } from '@kevincharm/noble-bn254-drand'
import { deployAnyrandStack, G2, getHashedRoundMsg, getRound } from './helpers'
import { RequestState } from '../lib/RequestState'

const { ethers } = hre
const isCoverage = Boolean((hre as any).__SOLIDITY_COVERAGE_RUNNING)

const abi = ethers.AbiCoder.defaultAbiCoder()

describe('Anyrand', () => {
    let deployer: SignerWithAddress
    let bob: SignerWithAddress
    let anyrandImpl: AnyrandHarness
    let anyrand: AnyrandHarness
    let anyrandArgs: Parameters<Anyrand['init']>
    let drandBeacon: DrandBeacon
    let consumer: AnyrandConsumer
    let beaconPubKey: G2
    let beaconSecretKey: Uint8Array
    let pubKeyHash: string
    let beaconPeriod = 1n
    let beaconGenesisTimestamp = 1702549672n
    let gasStation: GasStationEthereum
    beforeEach(async () => {
        ;[deployer, bob] = await ethers.getSigners()
        // drand beacon details
        beaconSecretKey = bn254.utils.randomPrivateKey()
        beaconPubKey = bn254.G2.ProjectivePoint.fromPrivateKey(beaconSecretKey)
        ;({ anyrand, anyrandImpl, anyrandArgs, drandBeacon, gasStation } = await deployAnyrandStack(
            {
                deployer,
                beacon: {
                    pubKey: beaconPubKey.toHex(),
                    genesisTimestamp: beaconGenesisTimestamp,
                    period: beaconPeriod,
                },
            },
        ))
        pubKeyHash = await drandBeacon.publicKeyHash()
        consumer = await new AnyrandConsumer__factory(deployer).deploy(await anyrand.getAddress())
    })

    describe('init', () => {
        beforeEach(async () => {
            // Uninitialised proxy
            const proxy = await new ERC1967Proxy__factory(deployer).deploy(
                anyrandImpl.getAddress(),
                '0x',
            )
            anyrand = AnyrandHarness__factory.connect(await proxy.getAddress(), deployer)
        })

        it('should initialise once', async () => {
            const tx = anyrand.init(...anyrandArgs)
            await expect(tx)
                .to.emit(anyrand, 'OwnershipTransferred')
                .withArgs(ZeroAddress, deployer.address)
            await expect(tx)
                .to.emit(anyrand, 'BeaconUpdated')
                .withArgs(await drandBeacon.getAddress())
            await expect(tx)
                .to.emit(anyrand, 'RequestPremiumMultiplierUpdated')
                .withArgs(anyrandArgs[1])
            await expect(tx).to.emit(anyrand, 'MaxCallbackGasLimitUpdated').withArgs(anyrandArgs[2])
            await expect(tx).to.emit(anyrand, 'MaxDeadlineDeltaUpdated').withArgs(anyrandArgs[3])
            await expect(tx)
                .to.emit(anyrand, 'GasStationUpdated')
                .withArgs(await gasStation.getAddress())
            // Should revert if initialised again
            await expect(anyrand.init(...anyrandArgs)).to.be.reverted
        })

        it('should revert if beacon is invalid', async () => {
            const args = [...anyrandArgs] as typeof anyrandArgs
            const beacon = await new Dummy__factory(deployer).deploy()
            args[0] = await beacon.getAddress()
            await expect(anyrand.init(...args)).to.be.reverted
        })
    })

    describe('upgrade', () => {
        it('should upgrade if called by owner', async () => {
            await expect(anyrand.upgradeToAndCall(await anyrandImpl.getAddress(), '0x')).to.not.be
                .reverted
        })

        it('should revert if called by some rando', async () => {
            await expect(
                anyrand.connect(bob).upgradeToAndCall(await anyrandImpl.getAddress(), '0x'),
            ).to.be.revertedWithCustomError(anyrand, 'Unauthorized')
        })
    })

    describe('typeAndVersion', () => {
        it('should return the correct type', async () => {
            expect(await anyrand.typeAndVersion()).to.match(/^Anyrand\s\d+\.\d+\.\d+$/)
        })
    })

    describe('withdrawETH', () => {
        beforeEach(async () => {
            await setBalance(await anyrand.getAddress(), parseEther('10'))
        })

        it('should withdraw all ETH if amount==0 called by owner', async () => {
            await expect(anyrand.withdrawETH(0))
                .to.emit(anyrand, 'ETHWithdrawn')
                .withArgs(parseEther('10'))
        })

        it('should withdraw specified ETH amount if called by owner', async () => {
            await expect(anyrand.withdrawETH(parseEther('5')))
                .to.emit(anyrand, 'ETHWithdrawn')
                .withArgs(parseEther('5'))
        })

        it('should revert if called by non-owner', async () => {
            await expect(anyrand.connect(bob).withdrawETH(0)).to.be.revertedWithCustomError(
                anyrand,
                'Unauthorized',
            )
        })

        it('should revert if caller reverts on receiving ETH', async () => {
            const _dummy = await new Dummy__factory(deployer).deploy()
            await impersonateAccount(await _dummy.getAddress())
            const dummy = await ethers.getSigner(await _dummy.getAddress())
            await setBalance(dummy.address, parseEther('10'))
            await anyrand.transferOwnership(dummy.address)
            await expect(anyrand.connect(dummy).withdrawETH(0)).to.be.revertedWithCustomError(
                anyrand,
                'TransferFailed',
            )
        })
    })

    describe('getRequestPrice', () => {
        let maxFeePerGas: bigint
        let maxPriorityFeePerGas: bigint
        beforeEach(async () => {
            ;({ maxFeePerGas, maxPriorityFeePerGas } = await ethers.provider
                .getFeeData()
                .then((res) => ({
                    maxFeePerGas: res.maxFeePerGas!,
                    maxPriorityFeePerGas: res.maxPriorityFeePerGas!,
                })))
        })

        it('should return the correct request price', async () => {
            const [requestPrice0] = await anyrand.getRequestPrice(100_000, {
                maxFeePerGas,
                maxPriorityFeePerGas,
            })
            const [requestPrice1] = await anyrand.getRequestPrice(200_000, {
                maxFeePerGas,
                maxPriorityFeePerGas,
            })
            expect(requestPrice1).to.be.gt(requestPrice0)
            const [requestPrice2] = await anyrand.getRequestPrice(500_000, {
                maxFeePerGas,
                maxPriorityFeePerGas,
            })
            expect(requestPrice2).be.gt(requestPrice1)
            const [gasCost] = await anyrand.gas_getRequestPrice(500_000, {
                maxFeePerGas,
                maxPriorityFeePerGas,
            })
            console.log(`#getRequestPrice gas: ${gasCost}`)
        })
    })

    describe('getRound', () => {
        it('should return the same round for deadlines that round up to the same beacon round', async () => {
            const genesis = 1727521075n
            const period = 3n
            // round = ceil((1728859790-genesis)/period)
            // => ceil(446238.3333333333)
            // => 446239
            const d0 = 1728859790n
            // round = ceil((1728859792-genesis)/period)
            // => ceil(446239)
            // => 446239
            const d1 = 1728859792n // d0 + period - 1n
            const r0 = getRound(genesis, d0, period)
            const r1 = getRound(genesis, d1, period)
            expect(r0).to.eq(446239n)
            expect(r0).to.eq(r1)
            expect(await anyrand.getRound(genesis, d0, period)).to.eq(r0)
            expect(await anyrand.getRound(genesis, d1, period)).to.eq(r1)

            // round = ceil((1728859793-genesis)/period)
            // => ceil(446239.3333333333)
            // => 446240
            const d2 = 1728859793n // d0 + period
            const r2 = getRound(genesis, d2, period)
            expect(r2).to.eq(r1 + 1n)
            expect(await anyrand.getRound(genesis, d2, period)).to.eq(r2)
        })
    })

    describe('requestRandomness', () => {
        let gasPrice: bigint
        let requestPrice: bigint
        let effectiveFeePerGas: bigint
        let callbackGasLimit: bigint
        beforeEach(async () => {
            ;({ gasPrice } = await ethers.provider.getFeeData().then((res) => ({
                gasPrice: res.gasPrice!,
                maxFeePerGas: res.maxFeePerGas!,
                maxPriorityFeePerGas: res.maxPriorityFeePerGas!,
            })))
            callbackGasLimit = 100_000n
            ;[requestPrice, effectiveFeePerGas] = await anyrand.getRequestPrice(callbackGasLimit, {
                gasPrice,
            })
        })

        it('should request randomness', async () => {
            const deadline = BigInt(await time.latest()) + 31n
            const requestId = await anyrand.nextRequestId()
            await expect(
                anyrand.requestRandomness(deadline, callbackGasLimit, {
                    value: requestPrice,
                    gasPrice,
                }),
            )
                .to.emit(anyrand, 'RandomnessRequested')
                .withArgs(
                    requestId,
                    deployer.address,
                    pubKeyHash,
                    getRound(beaconGenesisTimestamp, deadline, beaconPeriod),
                    callbackGasLimit,
                    requestPrice,
                    effectiveFeePerGas,
                )
        })

        it('should revert if request price returns too high effective gas price', async () => {
            ;({ anyrand } = await deployAnyrandStack({
                deployer,
                beacon: (await drandBeacon.getAddress()) as `0x${string}`,
                maxFeePerGas: parseUnits('5', 'gwei'),
            }))

            // Simulate gas spike to 10 gwei
            await setNextBlockBaseFeePerGas(parseUnits('10', 'gwei'))
            gasPrice = await ethers.provider.getFeeData().then((res) => res.gasPrice!)

            // Request must always succeed, even if gas price is above maxFeePerGas
            const callbackGasLimit = 100_000n
            const [cappedRequestPrice, effectiveGasPrice] = await anyrand.getRequestPrice(
                callbackGasLimit,
                {
                    gasPrice,
                },
            )
            const maxFeePerGas = await anyrand.maxFeePerGas()
            expect(effectiveGasPrice).to.eq(maxFeePerGas) // capped
            expect(cappedRequestPrice).to.eq(maxFeePerGas * callbackGasLimit)

            const deadline = BigInt(await time.latest()) + 31n
            const requestId = await anyrand.nextRequestId()
            const round = getRound(beaconGenesisTimestamp, deadline, beaconPeriod)
            await expect(
                anyrand.requestRandomness(deadline, callbackGasLimit, {
                    value: cappedRequestPrice,
                    gasPrice,
                }),
            )
                .to.emit(anyrand, 'RandomnessRequested')
                .withArgs(
                    requestId,
                    deployer.address,
                    pubKeyHash,
                    round,
                    callbackGasLimit,
                    cappedRequestPrice,
                    maxFeePerGas,
                )

            if (isCoverage) {
                // solidity-coverage sets gas to 1 wei
                await setNextBlockBaseFeePerGas(1)
            }
        })

        it('should revert if payment is incorrect', async () => {
            await expect(
                anyrand.requestRandomness((await time.latest()) + 31, callbackGasLimit, {
                    value: requestPrice / 2n, // not enough
                    gasPrice,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'IncorrectPayment')
            await expect(
                anyrand.requestRandomness((await time.latest()) + 31, callbackGasLimit, {
                    value: requestPrice * 2n, // too much
                    gasPrice,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'IncorrectPayment')
        })

        it('should revert if gas limit too high', async () => {
            const tooHighGasLimit = (await anyrand.maxCallbackGasLimit()) + 1n
            const [tooHighRequestPrice] = await anyrand.getRequestPrice(tooHighGasLimit, {
                gasPrice,
            })
            const deadline = BigInt(await time.latest()) + 31n
            await expect(
                anyrand.requestRandomness(deadline, tooHighGasLimit, {
                    value: tooHighRequestPrice,
                    gasPrice,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'OverGasLimit')
        })

        it('should revert if deadline too far in the future', async () => {
            const deadline = BigInt(await time.latest()) + (await anyrand.maxDeadlineDelta()) + 10n
            await expect(
                anyrand.requestRandomness(deadline, callbackGasLimit, {
                    value: requestPrice,
                    gasPrice,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidDeadline')
        })

        it('should revert if deadline is before genesis', async () => {
            const invalidDeadline = beaconGenesisTimestamp - 1n
            await expect(
                anyrand.requestRandomness(invalidDeadline, callbackGasLimit, {
                    value: requestPrice,
                    gasPrice,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidDeadline')
        })

        it('should revert if deadline is not at least one period after current timestamp', async () => {
            const deadline = BigInt(await time.latest()) + beaconPeriod - 1n
            const requestId = await anyrand.nextRequestId()
            await expect(
                anyrand.requestRandomness(deadline, callbackGasLimit, {
                    value: requestPrice,
                    gasPrice,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidDeadline')
            expect(await anyrand.getRequestState(requestId)).to.eq(RequestState.Nonexistent)
        })

        it('should revert if requestRandomness is called reentrantly', async () => {
            const reentrantRequester = await new ReentrantRequester__factory(deployer).deploy(
                await anyrand.getAddress(),
            )
            await setBalance(await reentrantRequester.getAddress(), parseEther('10'))
            const deadline = BigInt(await time.latest()) + 30n
            const callbackGasLimit = 500_000n
            const requestId = await anyrand.nextRequestId()
            await reentrantRequester.getRandom(deadline, callbackGasLimit)

            const pubKeyHash = await drandBeacon.publicKeyHash()
            const round = getRound(beaconGenesisTimestamp, deadline, beaconPeriod)
            const M = getHashedRoundMsg(round)
            const signature = bn254.signShortSignature(M, beaconSecretKey).toAffine()
            await expect(
                reentrantRequester.fulfillRandomness(
                    requestId,
                    pubKeyHash,
                    round,
                    callbackGasLimit,
                    [signature.x, signature.y],
                ),
            )
                .to.emit(anyrand, 'RandomnessCallbackFailed')
                .withArgs(
                    requestId,
                    /** ReentrancyGuardReentrantCall() */
                    '0x3ee5aeb500000000000000000000000000000000000000000000000000000000',
                    callbackGasLimit,
                    (x: bigint) => x <= callbackGasLimit,
                )
            expect(await anyrand.getRequestState(requestId)).to.eq(RequestState.Failed)
        })
    })

    describe('fulfillRandomness', () => {
        let gasPrice: bigint
        let requestPrice: bigint
        let effectiveFeePerGas: bigint
        let callbackGasLimit: bigint
        beforeEach(async () => {
            ;({ gasPrice } = await ethers.provider.getFeeData().then((res) => ({
                gasPrice: res.gasPrice!,
            })))
            callbackGasLimit = 100_000n
            ;[requestPrice, effectiveFeePerGas] = await anyrand.getRequestPrice(callbackGasLimit, {
                gasPrice,
            })
        })

        it('should fulfill valid randomness request', async () => {
            const deadline = BigInt(await time.latest()) + 30n
            const requestId = await anyrand.nextRequestId()
            const requester = await consumer.getAddress()
            const pubKeyHash = await drandBeacon.publicKeyHash()
            const round = getRound(beaconGenesisTimestamp, deadline, beaconPeriod)
            const M = getHashedRoundMsg(round)
            const signature = bn254.signShortSignature(M, beaconSecretKey).toAffine()

            // Request
            await expect(
                consumer.getRandom(deadline, callbackGasLimit, {
                    value: requestPrice,
                    gasPrice,
                }),
            )
                .to.emit(anyrand, 'RandomnessRequested')
                .withArgs(
                    requestId,
                    await consumer.getAddress(),
                    pubKeyHash,
                    round,
                    callbackGasLimit,
                    requestPrice,
                    effectiveFeePerGas,
                )

            // Fulfill
            const chainId = await ethers.provider.getNetwork().then((network) => network.chainId)
            const randomness = keccak256(
                abi.encode(
                    ['uint256', 'uint256', 'uint256', 'address', 'uint256', 'address'],
                    [
                        signature.x,
                        signature.y,
                        chainId,
                        await anyrand.getAddress(),
                        requestId,
                        requester,
                    ],
                ),
            )
            await expect(
                anyrand.fulfillRandomness(
                    requestId,
                    requester,
                    pubKeyHash,
                    round,
                    callbackGasLimit,
                    [signature.x, signature.y],
                ),
            )
                .to.emit(anyrand, 'RandomnessFulfilled')
                .withArgs(requestId, randomness, true, (x: bigint) => x <= callbackGasLimit)
            expect(await consumer.randomness(requestId)).to.eq(randomness)
            expect(await anyrand.getRequestState(requestId)).to.eq(RequestState.Fulfilled)
        })

        it('should revert if callback tries to reenter fulfillRandomness', async () => {
            const reentrantFulfiller = await new ReentrantFulfiller__factory(deployer).deploy(
                await anyrand.getAddress(),
            )
            await setBalance(await reentrantFulfiller.getAddress(), parseEther('10'))
            const deadline = BigInt(await time.latest()) + 30n
            const requestId = await anyrand.nextRequestId()
            const callbackGasLimit = 500_000n
            await reentrantFulfiller.getRandom(deadline, callbackGasLimit)

            // Looped fulfillRandomness
            const pubKeyHash = await drandBeacon.publicKeyHash()
            const round = getRound(beaconGenesisTimestamp, deadline, beaconPeriod)
            const M = getHashedRoundMsg(round)
            const signature = bn254.signShortSignature(M, beaconSecretKey).toAffine()
            await expect(
                reentrantFulfiller.fulfillRandomness(
                    requestId,
                    pubKeyHash,
                    round,
                    callbackGasLimit,
                    [signature.x, signature.y],
                ),
            )
                .to.emit(anyrand, 'RandomnessCallbackFailed')
                .withArgs(
                    requestId,
                    /** ReentrancyGuardReentrantCall() */
                    '0x3ee5aeb500000000000000000000000000000000000000000000000000000000',
                    callbackGasLimit,
                    (x: bigint) => x <= callbackGasLimit,
                )
            expect(await anyrand.getRequestState(requestId)).to.eq(RequestState.Failed)
        })

        it('should revert if request hash is invalid', async () => {
            const deadline = BigInt(await time.latest()) + 30n
            const requestId = await anyrand.nextRequestId()
            const requester = await consumer.getAddress()
            const pubKeyHash = await drandBeacon.publicKeyHash()
            const round = getRound(beaconGenesisTimestamp, deadline, beaconPeriod)
            const M = getHashedRoundMsg(round)
            const signature = bn254.signShortSignature(M, beaconSecretKey).toAffine()

            // Request
            await expect(
                consumer.getRandom(deadline, callbackGasLimit, {
                    value: requestPrice,
                    gasPrice,
                }),
            )
                .to.emit(anyrand, 'RandomnessRequested')
                .withArgs(
                    requestId,
                    await consumer.getAddress(),
                    pubKeyHash,
                    round,
                    callbackGasLimit,
                    requestPrice,
                    effectiveFeePerGas,
                )

            // Fulfill with request details that hash to something unexpected
            await expect(
                anyrand.fulfillRandomness(
                    requestId,
                    Wallet.createRandom().address /** wrong requester */,
                    pubKeyHash,
                    round,
                    callbackGasLimit,
                    [signature.x, signature.y],
                ),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidRequestHash')

            await expect(
                anyrand.fulfillRandomness(
                    requestId,
                    requester,
                    randomBytes(32) /** wrong pubKeyHash */,
                    round,
                    callbackGasLimit,
                    [signature.x, signature.y],
                ),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidRequestHash')

            await expect(
                anyrand.fulfillRandomness(
                    requestId,
                    requester,
                    pubKeyHash,
                    round + 1n /** wrong round */,
                    callbackGasLimit,
                    [signature.x, signature.y],
                ),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidRequestHash')

            await expect(
                anyrand.fulfillRandomness(
                    requestId,
                    requester,
                    pubKeyHash,
                    round,
                    callbackGasLimit + 1n /** wrong gas limit */,
                    [signature.x, signature.y],
                ),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidRequestHash')

            expect(await anyrand.getRequestState(requestId)).to.eq(RequestState.Pending)
        })

        it('should not revert if callback fails', async () => {
            const deadline = BigInt(await time.latest()) + 30n
            const requestId = await anyrand.nextRequestId()
            const requester = await new RevertingCallback__factory(deployer).deploy(
                await anyrand.getAddress(),
            )
            const pubKeyHash = await drandBeacon.publicKeyHash()
            const round = getRound(beaconGenesisTimestamp, deadline, beaconPeriod)
            const M = getHashedRoundMsg(round)
            const signature = bn254.signShortSignature(M, beaconSecretKey).toAffine()

            // Request
            await expect(
                requester.getRandom(deadline, callbackGasLimit, {
                    value: requestPrice,
                    gasPrice,
                }),
            )
                .to.emit(anyrand, 'RandomnessRequested')
                .withArgs(
                    requestId,
                    await requester.getAddress(),
                    pubKeyHash,
                    round,
                    callbackGasLimit,
                    requestPrice,
                    effectiveFeePerGas,
                )

            // Fulfill
            const fulfillArgs: Parameters<typeof anyrand.fulfillRandomness> = [
                requestId,
                await requester.getAddress(),
                pubKeyHash,
                round,
                callbackGasLimit,
                [signature.x, signature.y],
            ]
            await expect(anyrand.fulfillRandomness(...fulfillArgs))
                .to.emit(anyrand, 'RandomnessCallbackFailed')
                .withArgs(
                    requestId,
                    /** AlwaysBeErroring() */
                    '0x3166292600000000000000000000000000000000000000000000000000000000',
                    callbackGasLimit,
                    (x: bigint) => x <= callbackGasLimit,
                )
            expect(await anyrand.getRequestState(requestId)).to.eq(RequestState.Failed)

            // It should, however, revert if tried again
            await expect(anyrand.fulfillRandomness(...fulfillArgs)).to.be.revertedWithCustomError(
                anyrand,
                'InvalidRequestState',
            )
        })
    })

    describe('setBeacon', () => {
        let newBeacon: DrandBeacon
        beforeEach(async () => {
            const newBeaconSecretKey = bn254.utils.randomPrivateKey()
            const newBeaconPubKey = bn254.G2.ProjectivePoint.fromPrivateKey(newBeaconSecretKey)
            const pkAffine = newBeaconPubKey.toAffine()
            newBeacon = await new DrandBeacon__factory(deployer).deploy(
                [pkAffine.x.c0, pkAffine.x.c1, pkAffine.y.c0, pkAffine.y.c1],
                Math.floor(Date.now() / 1000),
                1,
            )
        })

        it('should set a new beacon if caller is owner', async () => {
            const currentPubKeyHash = await anyrand.currentBeaconPubKeyHash()
            const oldBeacon = await anyrand.beacon(currentPubKeyHash)
            await anyrand.setBeacon(await newBeacon.getAddress())
            const newPubKeyHash = await newBeacon.publicKeyHash()
            expect(newPubKeyHash).to.not.eq(currentPubKeyHash)
            expect(await anyrand.beacon(newPubKeyHash)).to.eq(await newBeacon.getAddress())
            expect(await anyrand.currentBeaconPubKeyHash()).to.eq(newPubKeyHash)

            // Old beacon should still be queryable (for inflight requests)
            expect(await anyrand.beacon(currentPubKeyHash)).to.eq(oldBeacon)
        })

        it('should revert if caller is not owner', async () => {
            await expect(
                anyrand.connect(bob).setBeacon(await newBeacon.getAddress()),
            ).to.be.revertedWithCustomError(anyrand, 'Unauthorized')
        })

        it('should revert if beacon is invalid', async () => {
            const dummyBeacon = await new Dummy__factory(deployer).deploy()
            await expect(
                anyrand.setBeacon(await dummyBeacon.getAddress()),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidBeacon')

            const emptyPubKeyBeacon = await new WhateverBeacon__factory(deployer).deploy(
                '0x',
                0n,
                0n,
            )
            await expect(
                anyrand.setBeacon(await emptyPubKeyBeacon.getAddress()),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidBeacon')
        })
    })

    describe('setRequestPremiumMultiplierBps', () => {
        it('should set the base request price if caller is owner', async () => {
            await anyrand.setRequestPremiumMultiplierBps(120_00) // 120%
            expect(await anyrand.requestPremiumMultiplierBps()).to.eq(120_00)
            const gasPrice = await ethers.provider.getFeeData().then((res) => res.gasPrice!)
            const [requestPrice120] = await anyrand.getRequestPrice(100_000n, {
                gasPrice,
            })

            await anyrand.setRequestPremiumMultiplierBps(60_00) // 60%
            expect(await anyrand.requestPremiumMultiplierBps()).to.eq(60_00)
            const [requestPrice60] = await anyrand.getRequestPrice(100_000n, {
                gasPrice,
            })
            expect(requestPrice60 * 2n).to.eq(requestPrice120)
        })

        it('should revert if caller is not owner', async () => {
            await expect(
                anyrand.connect(bob).setRequestPremiumMultiplierBps(120_00),
            ).to.be.revertedWithCustomError(anyrand, 'Unauthorized')
        })

        it('should allow free requests if multiplier is 0', async () => {
            await anyrand.setRequestPremiumMultiplierBps(0n)
            expect(await anyrand.requestPremiumMultiplierBps()).to.eq(0n)
            const [requestPrice] = await anyrand.getRequestPrice(100_000n, {
                gasPrice: await ethers.provider.getFeeData().then((res) => res.gasPrice!),
            })
            expect(requestPrice).to.eq(0n)
        })
    })

    describe('setMaxCallbackGasLimit', () => {
        it('should set the max callback gas limit if caller is owner', async () => {
            await anyrand.setMaxCallbackGasLimit(100_000n)
            expect(await anyrand.maxCallbackGasLimit()).to.eq(100_000n)
        })

        it('should revert if caller is not owner', async () => {
            await expect(
                anyrand.connect(bob).setMaxCallbackGasLimit(100_000n),
            ).to.be.revertedWithCustomError(anyrand, 'Unauthorized')
        })
    })

    describe('setMaxDeadlineDelta', () => {
        it('should set the max deadline delta if caller is owner', async () => {
            await anyrand.setMaxDeadlineDelta(7200n)
            expect(await anyrand.maxDeadlineDelta()).to.eq(7200n)
        })

        it('should revert if caller is not owner', async () => {
            await expect(
                anyrand.connect(bob).setMaxDeadlineDelta(7200n),
            ).to.be.revertedWithCustomError(anyrand, 'Unauthorized')
        })
    })

    describe('setGasStation', () => {
        let newGasStation: GasStationEthereum
        beforeEach(async () => {
            newGasStation = await new GasStationEthereum__factory(deployer).deploy()
        })

        it('should set the gas station if caller is owner', async () => {
            await anyrand.setGasStation(await newGasStation.getAddress())
            expect(await anyrand.gasStation()).to.eq(await newGasStation.getAddress())
        })

        it('should revert if caller is not owner', async () => {
            await expect(
                anyrand.connect(bob).setGasStation(await newGasStation.getAddress()),
            ).to.be.revertedWithCustomError(anyrand, 'Unauthorized')
        })
    })

    describe('requests', () => {
        it('should return a request hash for a requestId', async () => {
            const requestId = 42n
            const requester = await consumer.getAddress()
            const pubKeyHash = await drandBeacon.publicKeyHash()
            const round = 1n
            const callbackGasLimit = 100_000n
            await anyrand.setRequest(requestId, requester, pubKeyHash, round, callbackGasLimit)
            const requestHash = await anyrand.requests(requestId)
            expect(requestHash).to.eq(
                keccak256(
                    abi.encode(
                        [
                            'uint256',
                            'address',
                            'uint256',
                            'address',
                            'bytes32',
                            'uint256',
                            'uint256',
                        ],
                        [
                            await ethers.provider.getNetwork().then((network) => network.chainId),
                            await anyrand.getAddress(),
                            requestId,
                            requester,
                            pubKeyHash,
                            round,
                            callbackGasLimit,
                        ],
                    ),
                ),
            )
        })
    })

    describe('ownership', () => {
        it('should be transferrable', async () => {
            await anyrand.connect(bob).requestOwnershipHandover()
            expect(await anyrand.owner()).to.eq(deployer.address)
            await anyrand.completeOwnershipHandover(bob.address)
            expect(await anyrand.owner()).to.eq(bob.address)
        })

        it('should be renouncable', async () => {
            expect(await anyrand.owner()).to.eq(deployer.address)
            await anyrand.renounceOwnership()
            expect(await anyrand.owner()).to.eq(ZeroAddress)
        })
    })
})

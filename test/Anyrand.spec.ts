import { ethers } from 'hardhat'
import { impersonateAccount, setBalance, time } from '@nomicfoundation/hardhat-network-helpers'
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
    ReentrantFulfiler__factory,
    ReentrantRequester__factory,
    RevertingCallback__factory,
    WhateverBeacon__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { Wallet, ZeroAddress, keccak256, parseEther, parseUnits, randomBytes } from 'ethers'
import { expect } from 'chai'
import { bn254 } from '@kevincharm/noble-bn254-drand'
import { deployAnyrandStack, G2, getHashedRoundMsg, getRound } from './helpers'

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
            await expect(tx).to.emit(anyrand, 'RequestPremiumUpdated').withArgs(anyrandArgs[1])
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
        it('should upgrade if called from UPGRADER_ROLE', async () => {
            await anyrand.grantRoles(deployer.address, await anyrand.UPGRADER_ROLE())
            await expect(anyrand.upgradeToAndCall(await anyrandImpl.getAddress(), '0x')).to.not.be
                .reverted
        })

        it('should revert if called from non-UPGRADER_ROLE', async () => {
            await expect(
                anyrand.upgradeToAndCall(await anyrandImpl.getAddress(), '0x'),
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

        it('should withdraw all ETH if amount==0 called from ACCOUNTING_ROLE', async () => {
            await anyrand.grantRoles(deployer.address, await anyrand.ACCOUNTING_ROLE())
            await expect(anyrand.withdrawETH(0))
                .to.emit(anyrand, 'ETHWithdrawn')
                .withArgs(parseEther('10'))
        })

        it('should withdraw specified ETH amount if called from ACCOUNTING_ROLE', async () => {
            await anyrand.grantRoles(deployer.address, await anyrand.ACCOUNTING_ROLE())
            await expect(anyrand.withdrawETH(parseEther('5')))
                .to.emit(anyrand, 'ETHWithdrawn')
                .withArgs(parseEther('5'))
        })

        it('should revert if called from non-ACCOUNTING_ROLE', async () => {
            await expect(anyrand.withdrawETH(0)).to.be.revertedWithCustomError(
                anyrand,
                'Unauthorized',
            )
        })

        it('should revert if caller reverts on receiving ETH', async () => {
            const _dummy = await new Dummy__factory(deployer).deploy()
            await impersonateAccount(await _dummy.getAddress())
            const dummy = await ethers.getSigner(await _dummy.getAddress())
            await setBalance(dummy.address, parseEther('10'))
            await anyrand.grantRoles(dummy.address, await anyrand.ACCOUNTING_ROLE())
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
        })
    })

    describe('requestRandomness', () => {
        let gasPrice: bigint
        let requestPrice: bigint
        let callbackGasLimit: bigint
        beforeEach(async () => {
            ;({ gasPrice } = await ethers.provider.getFeeData().then((res) => ({
                gasPrice: res.gasPrice!,
                maxFeePerGas: res.maxFeePerGas!,
                maxPriorityFeePerGas: res.maxPriorityFeePerGas!,
            })))
            callbackGasLimit = 100_000n
            ;[requestPrice] = await anyrand.getRequestPrice(callbackGasLimit, {
                gasPrice,
            })
        })

        it('should request randomness', async () => {
            const deadline = BigInt(await time.latest()) + 31n
            const requestId = await anyrand.nextRequestId()
            await expect(
                anyrand.requestRandomness(deadline, callbackGasLimit, parseUnits('2', 'gwei'), {
                    value: requestPrice,
                    gasPrice,
                }),
            )
                .to.emit(anyrand, 'RandomnessRequested')
                .withArgs(
                    requestId,
                    deployer.address,
                    getRound(beaconGenesisTimestamp, deadline, beaconPeriod),
                    callbackGasLimit,
                    requestPrice,
                )
        })

        it('should revert if request price returns too high effective gas price', async () => {
            const [requestPrice, effectiveGasPrice] = await anyrand.getRequestPrice(100_000, {
                gasPrice,
            })
            await expect(
                anyrand.requestRandomness(
                    (await time.latest()) + 31,
                    callbackGasLimit,
                    effectiveGasPrice - 1n /** less than effective gas price */,
                    {
                        value: requestPrice,
                        gasPrice,
                    },
                ),
            )
                .to.be.revertedWithCustomError(anyrand, 'EffectiveFeePerGasTooHigh')
                .withArgs(effectiveGasPrice, effectiveGasPrice - 1n)
        })

        it('should revert if payment is incorrect', async () => {
            await expect(
                anyrand.requestRandomness(
                    (await time.latest()) + 31,
                    callbackGasLimit,
                    parseUnits('2', 'gwei'),
                    {
                        value: requestPrice / 2n, // not enough
                        gasPrice,
                    },
                ),
            ).to.be.revertedWithCustomError(anyrand, 'IncorrectPayment')
            await expect(
                anyrand.requestRandomness(
                    (await time.latest()) + 31,
                    callbackGasLimit,
                    parseUnits('2', 'gwei'),
                    {
                        value: requestPrice * 2n, // too much
                        gasPrice,
                    },
                ),
            ).to.be.revertedWithCustomError(anyrand, 'IncorrectPayment')
        })

        it('should revert if gas limit too high', async () => {
            const tooHighGasLimit = (await anyrand.maxCallbackGasLimit()) + 1n
            const [tooHighRequestPrice] = await anyrand.getRequestPrice(tooHighGasLimit, {
                gasPrice,
            })
            const deadline = BigInt(await time.latest()) + 31n
            await expect(
                anyrand.requestRandomness(deadline, tooHighGasLimit, parseUnits('2', 'gwei'), {
                    value: tooHighRequestPrice,
                    gasPrice,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'OverGasLimit')
        })

        it('should revert if deadline too far in the future', async () => {
            const deadline = BigInt(await time.latest()) + (await anyrand.maxDeadlineDelta()) + 10n
            await expect(
                anyrand.requestRandomness(deadline, callbackGasLimit, parseUnits('2', 'gwei'), {
                    value: requestPrice,
                    gasPrice,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidDeadline')
        })

        it('should revert if deadline is before genesis', async () => {
            const invalidDeadline = beaconGenesisTimestamp - 1n
            await expect(
                anyrand.requestRandomness(
                    invalidDeadline,
                    callbackGasLimit,
                    parseUnits('2', 'gwei'),
                    {
                        value: requestPrice,
                        gasPrice,
                    },
                ),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidDeadline')
        })

        it('should revert if deadline is not at least one period after current timestamp', async () => {
            const deadline = BigInt(await time.latest()) + beaconPeriod - 1n
            await expect(
                anyrand.requestRandomness(deadline, callbackGasLimit, parseUnits('2', 'gwei'), {
                    value: requestPrice,
                    gasPrice,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidDeadline')
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
                )
        })
    })

    describe('fulfillRandomness', () => {
        let gasPrice: bigint
        let requestPrice: bigint
        let callbackGasLimit: bigint
        beforeEach(async () => {
            ;({ gasPrice } = await ethers.provider.getFeeData().then((res) => ({
                gasPrice: res.gasPrice!,
            })))
            callbackGasLimit = 100_000n
            ;[requestPrice] = await anyrand.getRequestPrice(callbackGasLimit, {
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
                    round,
                    callbackGasLimit,
                    requestPrice,
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
                .withArgs(requestId, [randomness], true)
        })

        it('should revert if callback tries to reenter fulfillRandomness', async () => {
            const reentrantFulfiller = await new ReentrantFulfiler__factory(deployer).deploy(
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
                )
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
                    round,
                    callbackGasLimit,
                    requestPrice,
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
                    round,
                    callbackGasLimit,
                    requestPrice,
                )

            // Fulfill
            await expect(
                anyrand.fulfillRandomness(
                    requestId,
                    await requester.getAddress(),
                    pubKeyHash,
                    round,
                    callbackGasLimit,
                    [signature.x, signature.y],
                ),
            )
                .to.emit(anyrand, 'RandomnessCallbackFailed')
                .withArgs(
                    requestId,
                    /** AlwaysBeErroring() */
                    '0x3166292600000000000000000000000000000000000000000000000000000000',
                )
        })
    })

    describe('setBeacon', () => {
        let newBeacon: DrandBeacon
        beforeEach(async () => {
            const pkAffine = beaconPubKey.toAffine()
            newBeacon = await new DrandBeacon__factory(deployer).deploy(
                [pkAffine.x.c0, pkAffine.x.c1, pkAffine.y.c0, pkAffine.y.c1],
                beaconGenesisTimestamp,
                beaconPeriod,
            )
        })

        it('should set the beacon if caller has BEACON_ADMIN_ROLE', async () => {
            await anyrand.grantRoles(deployer.address, await anyrand.BEACON_ADMIN_ROLE())
            await anyrand.setBeacon(await newBeacon.getAddress())
            expect(await anyrand.beacon()).to.eq(await newBeacon.getAddress())
        })

        it('should revert if caller does not have BEACON_ADMIN_ROLE', async () => {
            await expect(
                anyrand.setBeacon(await newBeacon.getAddress()),
            ).to.be.revertedWithCustomError(anyrand, 'Unauthorized')
        })

        it('should revert if beacon is invalid', async () => {
            await anyrand.grantRoles(deployer.address, await anyrand.BEACON_ADMIN_ROLE())

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

    describe('setRequestPremiumBps', () => {
        it('should set the base request price if caller has CONFIGURATOR_ROLE', async () => {
            await anyrand.grantRoles(deployer.address, await anyrand.CONFIGURATOR_ROLE())
            await anyrand.setRequestPremiumBps(20_00) // 20%
            expect(await anyrand.requestPremiumBps()).to.eq(20_00)
        })

        it('should revert if caller does not have CONFIGURATOR_ROLE', async () => {
            await expect(anyrand.setRequestPremiumBps(20_00)).to.be.revertedWithCustomError(
                anyrand,
                'Unauthorized',
            )
        })
    })

    describe('setMaxCallbackGasLimit', () => {
        it('should set the max callback gas limit if caller has CONFIGURATOR_ROLE', async () => {
            await anyrand.grantRoles(deployer.address, await anyrand.CONFIGURATOR_ROLE())
            await anyrand.setMaxCallbackGasLimit(100_000n)
            expect(await anyrand.maxCallbackGasLimit()).to.eq(100_000n)
        })

        it('should revert if caller does not have CONFIGURATOR_ROLE', async () => {
            await expect(anyrand.setMaxCallbackGasLimit(100_000n)).to.be.revertedWithCustomError(
                anyrand,
                'Unauthorized',
            )
        })
    })

    describe('setMaxDeadlineDelta', () => {
        it('should set the max deadline delta if caller has CONFIGURATOR_ROLE', async () => {
            await anyrand.grantRoles(deployer.address, await anyrand.CONFIGURATOR_ROLE())
            await anyrand.setMaxDeadlineDelta(7200n)
            expect(await anyrand.maxDeadlineDelta()).to.eq(7200n)
        })

        it('should revert if caller does not have CONFIGURATOR_ROLE', async () => {
            await expect(anyrand.setMaxDeadlineDelta(7200n)).to.be.revertedWithCustomError(
                anyrand,
                'Unauthorized',
            )
        })
    })

    describe('setGasStation', () => {
        let newGasStation: GasStationEthereum
        beforeEach(async () => {
            newGasStation = await new GasStationEthereum__factory(deployer).deploy()
        })

        it('should set the gas station if caller has CONFIGURATOR_ROLE', async () => {
            await anyrand.grantRoles(deployer.address, await anyrand.CONFIGURATOR_ROLE())
            await anyrand.setGasStation(await newGasStation.getAddress())
            expect(await anyrand.gasStation()).to.eq(await newGasStation.getAddress())
        })

        it('should revert if caller does not have CONFIGURATOR_ROLE', async () => {
            await expect(
                anyrand.setGasStation(await newGasStation.getAddress()),
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
})

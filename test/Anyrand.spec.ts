import { ethers } from 'hardhat'
import { impersonateAccount, setBalance, time } from '@nomicfoundation/hardhat-network-helpers'
import {
    Anyrand,
    AnyrandConsumer,
    AnyrandConsumer__factory,
    AnyrandHarness,
    AnyrandHarness__factory,
    Anyrand__factory,
    DrandBeacon,
    Dummy__factory,
    ERC1967Proxy__factory,
    GasStationEthereum,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { ZeroAddress, parseEther } from 'ethers'
import { expect } from 'chai'
import { bn254 } from '@kevincharm/noble-bn254-drand'
import { deployAnyrandStack, G2, getHashedRoundMsg, getRound } from './helpers'

describe.only('Anyrand', () => {
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
            await expect(tx).to.emit(anyrand, 'RequestPriceUpdated').withArgs(anyrandArgs[1])
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
        it('should return the correct request price', async () => {
            const baseRequestPrice = await anyrand.baseRequestPrice()
            const requestPrice0 = await anyrand.getRequestPrice(100_000)
            const requestPrice1 = await anyrand.getRequestPrice(200_000)
            expect(requestPrice1 - baseRequestPrice).to.eq((requestPrice0 - baseRequestPrice) * 2n)
            const requestPrice2 = await anyrand.getRequestPrice(500_000)
            expect(requestPrice2 - baseRequestPrice).to.eq((requestPrice0 - baseRequestPrice) * 5n)
        })
    })

    describe('requestRandomness', () => {
        let maxFeePerGas: bigint
        let maxPriorityFeePerGas: bigint
        let requestPrice: bigint
        let callbackGasLimit: bigint
        beforeEach(async () => {
            ;({ maxFeePerGas, maxPriorityFeePerGas } = await ethers.provider
                .getFeeData()
                .then((res) => ({
                    maxFeePerGas: res.maxFeePerGas!,
                    maxPriorityFeePerGas: res.maxPriorityFeePerGas!,
                })))
            callbackGasLimit = 100_000n
            requestPrice = await anyrand.getRequestPrice(callbackGasLimit, {
                maxFeePerGas,
                maxPriorityFeePerGas,
            })
        })

        it('should request randomness', async () => {
            const deadline = BigInt((await time.latest()) + 31)
            const requestId = await anyrand.nextRequestId()
            await expect(
                anyrand.requestRandomness(deadline, callbackGasLimit, {
                    value: requestPrice,
                    maxFeePerGas,
                    maxPriorityFeePerGas,
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

        it('should revert if payment is incorrect', async () => {
            await expect(
                anyrand.requestRandomness((await time.latest()) + 31, callbackGasLimit, {
                    value: requestPrice / 2n, // not enough
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'IncorrectPayment')
            await expect(
                anyrand.requestRandomness((await time.latest()) + 31, callbackGasLimit, {
                    value: requestPrice * 2n, // too much
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'IncorrectPayment')
        })

        it('should revert if gas limit too high', async () => {
            const tooHighGasLimit = (await anyrand.maxCallbackGasLimit()) + 1n
            const tooHighRequestPrice = await anyrand.getRequestPrice(tooHighGasLimit, {
                maxFeePerGas,
                maxPriorityFeePerGas,
            })
            await expect(
                anyrand.requestRandomness((await time.latest()) + 31, tooHighGasLimit, {
                    value: tooHighRequestPrice,
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'OverGasLimit')
        })

        it('should revert if deadline too far in the future', async () => {
            const invalidDeadline =
                BigInt(await time.latest()) + (await anyrand.maxDeadlineDelta()) + 10n
            await expect(
                anyrand.requestRandomness(invalidDeadline, callbackGasLimit, {
                    value: requestPrice,
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidDeadline')
        })

        it('should revert if deadline is before genesis', async () => {
            const invalidDeadline = beaconGenesisTimestamp - 1n
            await expect(
                anyrand.requestRandomness(invalidDeadline, callbackGasLimit, {
                    value: requestPrice,
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidDeadline')
        })

        it('should revert if deadline is not at least one period after current timestamp', async () => {
            const deadline = BigInt(await time.latest()) + beaconPeriod - 1n
            await expect(
                anyrand.requestRandomness(deadline, callbackGasLimit, {
                    value: requestPrice,
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                }),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidDeadline')
        })
    })

    describe('verifyBeaconRound', () => {
        let maxFeePerGas: bigint
        let maxPriorityFeePerGas: bigint
        let requestPrice: bigint
        let callbackGasLimit: bigint
        beforeEach(async () => {
            ;({ maxFeePerGas, maxPriorityFeePerGas } = await ethers.provider
                .getFeeData()
                .then((res) => ({
                    maxFeePerGas: res.maxFeePerGas!,
                    maxPriorityFeePerGas: res.maxPriorityFeePerGas!,
                })))
            callbackGasLimit = 100_000n
            requestPrice = await anyrand.getRequestPrice(callbackGasLimit, {
                maxFeePerGas,
                maxPriorityFeePerGas,
            })
        })

        it('should verify a valid signature', async () => {
            const secondsToWait = 30n
            await consumer.getRandom(secondsToWait, callbackGasLimit, {
                value: requestPrice,
                maxFeePerGas,
                maxPriorityFeePerGas,
            })
            const round = getRound(
                beaconGenesisTimestamp,
                beaconGenesisTimestamp + secondsToWait,
                beaconPeriod,
            )
            const M = getHashedRoundMsg(round)
            const signature = bn254.signShortSignature(M, beaconSecretKey).toAffine()
            await expect(anyrand.verifyBeaconRound(round, [signature.x, signature.y])).to.not.be
                .reverted
        })

        it('should revert if signature was signed by the wrong key', async () => {
            const secondsToWait = 30n
            await consumer.getRandom(secondsToWait, callbackGasLimit, {
                value: requestPrice,
                maxFeePerGas,
                maxPriorityFeePerGas,
            })
            const round = getRound(
                beaconGenesisTimestamp,
                beaconGenesisTimestamp + secondsToWait,
                beaconPeriod,
            )
            const M = getHashedRoundMsg(round)
            const wrongSecretKey = bn254.utils.randomPrivateKey()
            const wrongSignature = bn254.signShortSignature(M, wrongSecretKey).toAffine()
            await expect(
                anyrand.verifyBeaconRound(round, [wrongSignature.x, wrongSignature.y]),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidSignature')
        })

        it('should revert if signature is not a valid G1 point', async () => {
            const secondsToWait = 30n
            await consumer.getRandom(secondsToWait, callbackGasLimit, {
                value: requestPrice,
                maxFeePerGas,
                maxPriorityFeePerGas,
            })
            const round = getRound(
                beaconGenesisTimestamp,
                beaconGenesisTimestamp + secondsToWait,
                beaconPeriod,
            )
            // Valid G1 points are simply (x,y) satisfying y^2 = x^3 + 3 \forall x,y \in F_r
            const invalidSignature: [bigint, bigint] = [2n, 2n]
            await expect(
                anyrand.verifyBeaconRound(round, invalidSignature),
            ).to.be.revertedWithCustomError(anyrand, 'InvalidSignature')
        })
    })
})

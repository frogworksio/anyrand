import * as hre from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import {
    Anyrand,
    AnyrandConsumer,
    AnyrandConsumer__factory,
    Anyrand__factory,
    DrandBeacon,
    DrandBeacon__factory,
    ERC1967Proxy__factory,
    GasStationEthereum,
    GasStationOptimism__factory,
    MockGasPriceOracle__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { Wallet, formatEther, formatUnits, getBytes, keccak256, parseEther } from 'ethers'
import { expect } from 'chai'
import { bn254 } from '@kevincharm/noble-bn254-drand'
import { deployAnyrandStack, getHashedRoundMsg, getRound } from './helpers'
import { DrandBeaconRound, getDrandBeaconInfo, getDrandBeaconRound } from '../lib/drand'
import { RequestState } from '../lib/RequestState'

const { ethers } = hre
const isCoverage = Boolean((hre as any).__SOLIDITY_COVERAGE_RUNNING)

type G1 = typeof bn254.G1.ProjectivePoint.BASE
type G2 = typeof bn254.G2.ProjectivePoint.BASE
const DST = 'BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_'

;(isCoverage ? describe.skip : describe)('Anyrand e2e', () => {
    let deployer: SignerWithAddress
    let bob: SignerWithAddress
    let anyrandImpl: Anyrand
    let anyrand: Anyrand
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

    it('runs happy path', async () => {
        const callbackGasLimit = 500_000
        const gasPrice = await ethers.provider.getFeeData().then((fee) => fee.gasPrice!)
        console.log(`Gas price:\t${formatUnits(gasPrice, 'gwei')} gwei`)
        const [requestPrice] = await anyrand.getRequestPrice(callbackGasLimit, {
            gasPrice,
        })
        console.log(`Request price:\t${formatEther(requestPrice)} ETH`)
        const deadline = BigInt(await time.latest()) + 10n
        const getRandomTx = await consumer
            .getRandom(deadline, callbackGasLimit, {
                value: requestPrice,
                gasPrice,
            })
            .then((tx) => tx.wait(1))
        const { requestId, requester, round } = anyrand.interface.decodeEventLog(
            'RandomnessRequested',
            getRandomTx?.logs[0].data!,
            getRandomTx?.logs[0].topics,
        ) as unknown as {
            requestId: bigint
            beaconPubKeyHash: string
            requester: string
            round: bigint
        }

        // Simulate drand beacon response
        const roundBytes = getBytes('0x' + round.toString(16).padStart(16, '0'))
        const M = bn254.G1.hashToCurve(getBytes(keccak256(roundBytes) as `0x${string}`), {
            DST,
        }) as G1
        const roundBeacon = {
            round,
            signature: bn254.signShortSignature(M, beaconSecretKey).toAffine(),
        }

        // Wait 10s & fulfill
        await time.increase(10)
        const fulfillRandomnessArgs: Parameters<typeof anyrand.fulfillRandomness> = [
            requestId,
            requester,
            await drandBeacon.publicKeyHash(),
            round,
            callbackGasLimit,
            [roundBeacon.signature.x, roundBeacon.signature.y],
        ]
        const fulfillTx = await anyrand.fulfillRandomness(...fulfillRandomnessArgs)
        expect(fulfillTx).to.emit(anyrand, 'RandomnessFulfilled')
        const randomness = await consumer.randomness(requestId)
        expect(randomness).to.not.eq(0)

        // Calcs
        const rawSignedTx = getBytes(
            await Wallet.createRandom().signTransaction(
                await anyrand.fulfillRandomness.populateTransaction(...fulfillRandomnessArgs),
            ),
        )
        const zeros = rawSignedTx.filter((v) => v === 0).byteLength
        const nonZeros = rawSignedTx.byteLength - zeros
        console.log(
            `Raw signed fulfillRandomness tx: ${zeros} zero bytes, ${nonZeros} non-zero bytes`,
        )
    })

    it('works with evmnet', async () => {
        const drandBeaconInfo = await getDrandBeaconInfo('evmnet')
        expect(drandBeaconInfo.beacon_id).to.eq('evmnet')
        ;({ anyrand, anyrandImpl, anyrandArgs, drandBeacon, gasStation } = await deployAnyrandStack(
            {
                deployer,
                beacon: {
                    pubKey: drandBeaconInfo.public_key,
                    genesisTimestamp: BigInt(drandBeaconInfo.genesis_time),
                    period: BigInt(drandBeaconInfo.period),
                },
            },
        ))
        consumer = await new AnyrandConsumer__factory(deployer).deploy(await anyrand.getAddress())

        const deadline = BigInt(await time.latest()) + 5n
        expect(deadline).to.be.gt(drandBeaconInfo.genesis_time)
        const callbackGasLimit = 500_000
        const gasPrice = await ethers.provider.getFeeData().then((fee) => fee.gasPrice!)
        const [requestPrice] = await anyrand.getRequestPrice(callbackGasLimit, {
            gasPrice,
        })
        const requestId = await anyrand.nextRequestId()
        await consumer.getRandom(deadline, callbackGasLimit, {
            value: requestPrice,
            gasPrice,
        })

        const round = getRound(
            BigInt(drandBeaconInfo.genesis_time),
            deadline,
            BigInt(drandBeaconInfo.period),
        )
        let targetRound: DrandBeaconRound
        for (;;) {
            console.log(`Waiting for round ${round}...`)
            await new Promise((resolve) => setTimeout(resolve, drandBeaconInfo.period * 2 * 1000))
            try {
                targetRound = await getDrandBeaconRound('evmnet', Number(round))
                break
            } catch (e) {
                console.log(`Still waiting...`)
                continue
            }
        }

        const signature = bn254.G1.ProjectivePoint.fromHex(targetRound.signature).toAffine()
        await expect(
            anyrand.fulfillRandomness(
                requestId,
                await consumer.getAddress(),
                await drandBeacon.publicKeyHash(),
                round,
                callbackGasLimit,
                [signature.x, signature.y],
            ),
        ).to.emit(anyrand, 'RandomnessFulfilled')
    }).timeout(180_000)

    it('computes request price on OP chains', async () => {
        // Setup mock GasPriceOracle predeploy
        const mockGasPriceOracle = await new MockGasPriceOracle__factory(deployer).deploy()
        const mockGasPriceOracleDeployedBytecode = await ethers.provider.getCode(
            await mockGasPriceOracle.getAddress(),
        )
        expect(mockGasPriceOracleDeployedBytecode).to.not.eq('0x')
        await ethers.provider.send('hardhat_setCode', [
            '0x420000000000000000000000000000000000000F',
            mockGasPriceOracleDeployedBytecode,
        ])
        const gasPriceOracle = MockGasPriceOracle__factory.connect(
            '0x420000000000000000000000000000000000000F',
            deployer,
        )

        // Deploy OP GasStation
        const gasStationOptimism = await new GasStationOptimism__factory(deployer).deploy()
        const args: Parameters<Anyrand['init']> = [...anyrandArgs]
        args[args.length - 1] = await gasStationOptimism.getAddress()
        const anyrandProxy = await new ERC1967Proxy__factory(deployer).deploy(
            await anyrandImpl.getAddress(),
            anyrandImpl.interface.encodeFunctionData('init', args as any),
        )
        const anyrandOptimism = Anyrand__factory.connect(await anyrandProxy.getAddress(), deployer)
        const gasPrice = await ethers.provider.getFeeData().then((fee) => fee.gasPrice!)
        // Bedrock
        const [bedrockRequestPrice] = await anyrandOptimism.getRequestPrice(500_000, {
            gasPrice,
        })
        console.log(`Bedrock request price: ${formatEther(bedrockRequestPrice)}`)
        expect(bedrockRequestPrice).to.be.gt(0)
        // Ecotone
        await gasPriceOracle.setEcotone()
        const [ecotoneRequestPrice] = await anyrandOptimism.getRequestPrice(500_000, {
            gasPrice,
        })
        console.log(`Ecotone request price: ${formatEther(ecotoneRequestPrice)}`)
        expect(ecotoneRequestPrice).to.be.gt(0)
        // Fjord
        await gasPriceOracle.setFjord()
        const [fjordRequestPrice] = await anyrandOptimism.getRequestPrice(500_000, {
            gasPrice,
        })
        console.log(`Fjord request price: ${formatEther(fjordRequestPrice)}`)
        expect(fjordRequestPrice).to.be.gt(0)
    })

    it('honours current requests if beacon is upgraded while inflight', async () => {
        // Make the request
        const callbackGasLimit = 500_000
        const gasPrice = await ethers.provider.getFeeData().then((fee) => fee.gasPrice!)
        const [requestPrice] = await anyrand.getRequestPrice(callbackGasLimit, {
            gasPrice,
        })
        const deadline = BigInt(await time.latest()) + 10n
        const getRandomTx = await consumer
            .getRandom(deadline, callbackGasLimit, {
                value: requestPrice,
                gasPrice,
            })
            .then((tx) => tx.wait(1))
        const {
            requestId,
            requester,
            round,
            beaconPubKeyHash: pubKeyHash0,
        } = anyrand.interface.decodeEventLog(
            'RandomnessRequested',
            getRandomTx?.logs[0].data!,
            getRandomTx?.logs[0].topics,
        ) as unknown as {
            requestId: bigint
            beaconPubKeyHash: string
            requester: string
            round: bigint
        }

        // --- At this point, the request is inflight ---
        // Now we change the beacon
        const newBeaconSecretKey = bn254.utils.randomPrivateKey()
        const newBeaconPubKey = bn254.G2.ProjectivePoint.fromPrivateKey(newBeaconSecretKey)
        const newBeacon = await new DrandBeacon__factory(deployer).deploy(
            [
                newBeaconPubKey.x.c0,
                newBeaconPubKey.x.c1,
                newBeaconPubKey.y.c0,
                newBeaconPubKey.y.c1,
            ],
            beaconGenesisTimestamp,
            beaconPeriod,
        )
        const pubKeyHash1 = await newBeacon.publicKeyHash()
        await anyrand.setBeacon(await newBeacon.getAddress())
        // Sanity check - we changed the beacon
        expect(await anyrand.currentBeaconPubKeyHash()).to.eq(pubKeyHash1)
        expect(await anyrand.beacon(pubKeyHash1)).to.eq(await newBeacon.getAddress())
        // The current beacon pubkey != the one in the inflight request
        expect(pubKeyHash0).to.not.eq(pubKeyHash1)

        // Simulate valid drand beacon responses for each beacon
        const M = getHashedRoundMsg(round)
        const oldRoundBeacon = {
            round,
            signature: bn254.signShortSignature(M, beaconSecretKey).toAffine(),
        }
        const newRoundBeacon = {
            round,
            signature: bn254.signShortSignature(M, newBeaconSecretKey).toAffine(),
        }

        // Wait 10s for block timestamp to catchup
        await time.increase(10)

        // Try to fulfill with new beacon - should revert because this pubKeyHash makes the
        // request commitment (and therefore the request hash) mismatch
        await expect(
            anyrand.fulfillRandomness(requestId, requester, pubKeyHash1, round, callbackGasLimit, [
                newRoundBeacon.signature.x,
                newRoundBeacon.signature.y,
            ]),
        ).to.be.revertedWithCustomError(anyrand, 'InvalidRequestHash')
        expect(await anyrand.getRequestState(requestId)).to.eq(RequestState.Pending)

        // Fulfill with old beacon - this should succeed
        const fulfillTx = await anyrand.fulfillRandomness(
            requestId,
            requester,
            await drandBeacon.publicKeyHash(),
            round,
            callbackGasLimit,
            [oldRoundBeacon.signature.x, oldRoundBeacon.signature.y],
        )
        expect(fulfillTx).to.emit(anyrand, 'RandomnessFulfilled')
        expect(await anyrand.getRequestState(requestId)).to.eq(RequestState.Fulfilled)
        const randomness = await consumer.randomness(requestId)
        expect(randomness).to.not.eq(0)
    })
})

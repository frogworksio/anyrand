import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import {
    Anyrand,
    AnyrandConsumer,
    AnyrandConsumer__factory,
    Anyrand__factory,
    DrandBeacon,
    ERC1967Proxy__factory,
    GasStationEthereum,
    GasStationOptimism__factory,
    MockGasPriceOracle__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { Wallet, formatEther, formatUnits, getBytes, keccak256, parseEther } from 'ethers'
import { expect } from 'chai'
import { bn254 } from '@kevincharm/noble-bn254-drand'
import { deployAnyrandStack } from './helpers'

type G1 = typeof bn254.G1.ProjectivePoint.BASE
type G2 = typeof bn254.G2.ProjectivePoint.BASE
const DST = 'BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_'

describe('Anyrand e2e', () => {
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
        // Bedrock
        const [bedrockRequestPrice] = await anyrandOptimism.getRequestPrice(500_000)
        console.log(`Bedrock request price: ${formatEther(bedrockRequestPrice)}`)
        expect(bedrockRequestPrice).to.be.gt(0)
        // Ecotone
        await gasPriceOracle.setEcotone()
        const [ecotoneRequestPrice] = await anyrandOptimism.getRequestPrice(500_000)
        console.log(`Ecotone request price: ${formatEther(ecotoneRequestPrice)}`)
        expect(ecotoneRequestPrice).to.be.gt(0)
        // Fjord
        await gasPriceOracle.setFjord()
        const [fjordRequestPrice] = await anyrandOptimism.getRequestPrice(500_000)
        console.log(`Fjord request price: ${formatEther(fjordRequestPrice)}`)
        expect(fjordRequestPrice).to.be.gt(0)
    })
})

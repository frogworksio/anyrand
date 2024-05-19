import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import {
    Anyrand,
    AnyrandConsumer,
    AnyrandConsumer__factory,
    AnyrandOptimism__factory,
    Anyrand__factory,
    MockGasPriceOracle__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import {
    Wallet,
    formatEther,
    formatUnits,
    getBytes,
    keccak256,
    parseEther,
    toUtf8Bytes,
} from 'ethers'
import { expect } from 'chai'
import { BlsBn254 } from '@kevincharm/bls-bn254'
import type { G1, G2, Fr, Fp, Fp2 } from 'mcl-wasm'

const DOMAIN = 'BLS_SIG_BN254G1_XMD:KECCAK-256_SSWU_RO_NUL_'

describe('Anyrand', () => {
    let bls: BlsBn254
    before(async () => {
        bls = await BlsBn254.create()
    })

    let deployer: SignerWithAddress
    let bob: SignerWithAddress
    let anyrand: Anyrand
    let anyrandArgs: Parameters<Anyrand__factory['deploy']>
    let consumer: AnyrandConsumer
    let beaconPubKey: G2
    let beaconSecretKey: Fr
    let beaconPeriod = 1n
    let beaconGenesisTimestamp = 1702549672n
    beforeEach(async () => {
        ;[deployer, bob] = await ethers.getSigners()
        // drand beacon details
        ;({ pubKey: beaconPubKey, secretKey: beaconSecretKey } = await bls.createKeyPair())
        anyrandArgs = [
            bls.serialiseG2Point(beaconPubKey),
            beaconGenesisTimestamp,
            beaconPeriod,
            parseEther('0.001'),
            2_000_000,
            1800, // 30 mins
        ]
        anyrand = await new Anyrand__factory(deployer).deploy(...anyrandArgs)

        consumer = await new AnyrandConsumer__factory(deployer).deploy(await anyrand.getAddress())
    })

    it('runs happy path', async () => {
        const callbackGasLimit = 500_000
        const gasPrice = await ethers.provider.getFeeData().then((fee) => fee.gasPrice!)
        console.log(`Gas price:\t${formatUnits(gasPrice, 'gwei')} gwei`)
        const requestPrice = await anyrand.getRequestPrice(callbackGasLimit, {
            gasPrice,
        })
        console.log(`Request price:\t${formatEther(requestPrice)} ETH`)
        const getRandomTx = await consumer
            .getRandom(10, callbackGasLimit, {
                value: requestPrice,
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
        const M = await bls.hashToPoint(
            toUtf8Bytes(DOMAIN),
            getBytes(keccak256(roundBytes) as `0x${string}`),
        )
        const roundBeacon = {
            round,
            signature: bls.sign(M, beaconSecretKey).signature,
        }

        // Wait 10s & fulfill
        await time.increase(10)
        const fulfillRandomnessArgs: Parameters<typeof anyrand.fulfillRandomness> = [
            requestId,
            requester,
            round,
            callbackGasLimit,
            bls.serialiseG1Point(roundBeacon.signature),
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

        // Deploy OP Anyrand
        const anyrandOptimism = await new AnyrandOptimism__factory(deployer).deploy(...anyrandArgs)
        // Bedrock
        const bedrockRequestPrice = await anyrandOptimism.getRequestPrice(500_000)
        console.log(`Bedrock request price: ${formatEther(bedrockRequestPrice)}`)
        expect(bedrockRequestPrice).to.be.gt(0)
        // Ecotone
        await gasPriceOracle.setEcotone()
        const ecotoneRequestPrice = await anyrandOptimism.getRequestPrice(500_000)
        console.log(`Ecotone request price: ${formatEther(ecotoneRequestPrice)}`)
        expect(ecotoneRequestPrice).to.be.gt(0)
        // Fjord
        await gasPriceOracle.setFjord()
        const fjordRequestPrice = await anyrandOptimism.getRequestPrice(500_000)
        console.log(`Fjord request price: ${formatEther(fjordRequestPrice)}`)
        expect(fjordRequestPrice).to.be.gt(0)
    })
})

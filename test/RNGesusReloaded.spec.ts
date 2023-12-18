import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import {
    RNGesusReloaded,
    RNGesusReloadedConsumer,
    RNGesusReloadedConsumer__factory,
    RNGesusReloaded__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { Wallet, formatEther, formatUnits, getBytes, keccak256, parseEther } from 'ethers'
import { expect } from 'chai'
import {
    Fr,
    G2,
    createKeyPair,
    hashToPoint,
    serialiseG1Point,
    serialiseG2Point,
    sign,
} from '../lib/bls'

describe('RNGesusReloaded', () => {
    let deployer: SignerWithAddress
    let bob: SignerWithAddress
    let rngesus: RNGesusReloaded
    let consumer: RNGesusReloadedConsumer
    let beaconPubKey: G2
    let beaconSecretKey: Fr
    let beaconPeriod = 1n
    let beaconGenesisTimestamp = 1702549672n
    beforeEach(async () => {
        ;[deployer, bob] = await ethers.getSigners()
        // drand beacon details
        ;({ pubKey: beaconPubKey, secretKey: beaconSecretKey } = await createKeyPair())
        rngesus = await new RNGesusReloaded__factory(deployer).deploy(
            serialiseG2Point(beaconPubKey),
            beaconGenesisTimestamp,
            beaconPeriod,
            parseEther('0.001'),
            2_000_000,
            1800, // 30 mins
        )

        consumer = await new RNGesusReloadedConsumer__factory(deployer).deploy(
            await rngesus.getAddress(),
        )
    })

    it('runs happy path', async () => {
        const callbackGasLimit = 500_000
        const gasPrice = await ethers.provider.getFeeData().then((fee) => fee.gasPrice!)
        console.log(`Gas price:\t${formatUnits(gasPrice, 'gwei')} gwei`)
        const requestPrice = await rngesus.getRequestPrice(callbackGasLimit, {
            gasPrice,
        })
        console.log(`Request price:\t${formatEther(requestPrice)} ETH`)
        const getRandomTx = await consumer
            .getRandom(10, callbackGasLimit, {
                value: requestPrice,
            })
            .then((tx) => tx.wait(1))
        const { requestId, requester, round } = rngesus.interface.decodeEventLog(
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
        const M = await hashToPoint(keccak256(roundBytes) as `0x${string}`)
        const roundBeacon = {
            round,
            signature: await sign(M, beaconSecretKey).then(({ signature }) => signature),
        }

        // Wait 10s & fulfill
        await time.increase(10)
        const fulfillRandomnessArgs: Parameters<typeof rngesus.fulfillRandomness> = [
            requestId,
            requester,
            round,
            callbackGasLimit,
            serialiseG1Point(roundBeacon.signature),
        ]
        const fulfillTx = await rngesus.fulfillRandomness(...fulfillRandomnessArgs)
        expect(fulfillTx).to.emit(rngesus, 'RandomnessFulfilled')
        const randomness = await consumer.randomness(requestId)
        expect(randomness).to.not.eq(0)

        // Calcs
        const rawSignedTx = getBytes(
            await Wallet.createRandom().signTransaction(
                await rngesus.fulfillRandomness.populateTransaction(...fulfillRandomnessArgs),
            ),
        )
        const zeros = rawSignedTx.filter((v) => v === 0).byteLength
        const nonZeros = rawSignedTx.byteLength - zeros
        console.log(
            `Raw signed fulfillRandomness tx: ${zeros} zero bytes, ${nonZeros} non-zero bytes`,
        )
    })
})

import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import {
    RNGesusReloaded,
    RNGesusReloadedConsumer,
    RNGesusReloadedConsumer__factory,
    RNGesusReloaded__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { getBytes, keccak256, parseEther } from 'ethers'
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
        )

        consumer = await new RNGesusReloadedConsumer__factory(deployer).deploy(
            await rngesus.getAddress(),
        )
    })

    it('runs happy path', async () => {
        const callbackGasLimit = 500_000
        const getRandomTx = await consumer
            .getRandom(10, callbackGasLimit, {
                value: parseEther('0.001'),
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
        const fulfillTx = await rngesus.fulfillRandomness(
            requestId,
            requester,
            round,
            callbackGasLimit,
            serialiseG1Point(roundBeacon.signature),
        )
        expect(fulfillTx).to.emit(rngesus, 'RandomnessFulfilled')
        const randomness = await consumer.randomness(requestId)
        expect(randomness).to.not.eq(0)
    })
})

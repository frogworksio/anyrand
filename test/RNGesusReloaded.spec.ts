import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import {
    RNGesusReloaded,
    RNGesusReloadedConsumer,
    RNGesusReloadedConsumer__factory,
    RNGesusReloaded__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { getBytes, hexlify, keccak256, parseEther } from 'ethers'
import { expect } from 'chai'

const DRAND_BN254_INFO = {
    public_key:
        '1731c37e5e9d24c748d465dfacdfd0c8ad71150677d0086eba61d96d452a034912a4f6666e59df44dc6a0b2cdcae89137c1a594bdb25be7a2c81f4bf7634763121ebf198e661a8da76492bf629fd63fc8b3e71b9f5a11653e009e84f58bb2fbe2c50f58ab080f8e54f8cc5bc1f591a737f2c611a35cff799df69f38f2d886745',
    period: 1,
    genesis_time: 1702432747,
    hash: 'e566fb7b16fa767962b00ae623ce9fd610b8b2df48ea573c0258f7a5fbf36afd',
    groupHash: 'f5d54bfd6fd0ab42d881c3536ef7a7e0dcd443c51b65c8a67a2f8ba77c8126a8',
    schemeID: 'bls-bn254-unchained-on-g1',
    metadata: {
        beaconID: 'fairy-drand-bn254-dev',
    },
}

function decodeDrandPubKey({ public_key }: { public_key: string }) {
    const pkBytes = getBytes(`0x${public_key}`)
    const publicKey = [
        pkBytes.slice(32, 64),
        pkBytes.slice(0, 32),
        pkBytes.slice(96, 128),
        pkBytes.slice(64, 96),
    ].map((pkBuf) => BigInt(hexlify(pkBuf))) as [bigint, bigint, bigint, bigint]
    return publicKey
}

function decodeG1(point: string) {
    const sigBytes = getBytes(`0x${point}`)
    const sig = [sigBytes.slice(0, 32), sigBytes.slice(32, 64)].map((sigBuf) =>
        BigInt(hexlify(sigBuf)),
    ) as [bigint, bigint]
    return sig
}

describe('RNGesusReloaded', () => {
    let deployer: SignerWithAddress
    let bob: SignerWithAddress
    let rngesus: RNGesusReloaded
    let consumer: RNGesusReloadedConsumer
    let pkh: `0x${string}`
    beforeEach(async () => {
        ;[deployer, bob] = await ethers.getSigners()
        rngesus = await new RNGesusReloaded__factory(deployer).deploy(parseEther('0.001'))

        // Register beacon
        const publicKey = decodeDrandPubKey(DRAND_BN254_INFO)
        const beacon = {
            publicKey,
            period: BigInt(DRAND_BN254_INFO.period),
            genesisTimestamp: BigInt(DRAND_BN254_INFO.genesis_time),
        }
        await rngesus.registerBeacon(beacon)
        pkh = (await rngesus.hashPubKey(publicKey)) as `0x${string}`
        expect(await rngesus.beacons(pkh)).to.deep.eq([beacon.period, beacon.genesisTimestamp])

        consumer = await new RNGesusReloadedConsumer__factory(deployer).deploy(
            await rngesus.getAddress(),
        )
    })

    it('runs happy path', async () => {
        const getRandomTx = await consumer
            .getRandom(pkh, 10, {
                value: parseEther('0.001'),
            })
            .then((tx) => tx.wait(1))
        const { requestId, beaconPubKeyHash, requester, round, callbackContract } =
            rngesus.interface.decodeEventLog(
                'RandomnessRequested',
                getRandomTx?.logs[0].data!,
                getRandomTx?.logs[0].topics,
            ) as unknown as {
                requestId: bigint
                beaconPubKeyHash: string
                requester: string
                round: bigint
                callbackContract: string
            }

        // From: https://drand0.smoketre.es/e566fb7b16fa767962b00ae623ce9fd610b8b2df48ea573c0258f7a5fbf36afd/public/160139
        const roundBeacon = {
            round: 160139, // NB: This has a tight coupling with the forked block's timestamp
            randomness: '2c1d15da05af40da2527a226de62402c0731e25a48f095df30ac2452a275048f',
            signature:
                '2e7ea1d34df3b278c493063e1201b09fdc136a3752d59db23ab448c96d6f912917de46ad0e1ce62718d3623379340a8fae34cdd931e99e1ce732cd879fffc6c0',
        }

        // Wait 10s & fulfill
        await time.increase(10)
        const fulfillTx = await rngesus.fulfillRandomness(
            requestId,
            beaconPubKeyHash,
            requester,
            round,
            callbackContract,
            decodeG1(roundBeacon.signature),
        )
        expect(fulfillTx).to.emit(rngesus, 'RandomnessFulfilled')
        const randomness = await consumer.randomness(requestId)
        expect(randomness).to.not.eq(0)
    })
})

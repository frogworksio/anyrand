import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import {
    RNGesusReloaded,
    RNGesusReloadedConsumer,
    RNGesusReloadedConsumer__factory,
    RNGesusReloaded__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { parseEther } from 'ethers'
import { expect } from 'chai'
import { DRAND_BN254_INFO, decodeG2, decodeG1 } from '../lib/drand'

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
        const publicKey = decodeG2(DRAND_BN254_INFO.public_key)
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

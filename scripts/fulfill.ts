import { ethers } from 'hardhat'
import { RNGesusReloaded__factory } from '../typechain-types'
import { decodeG1 } from '../lib/drand'

const RNGESUS_ADDRESS = '0x4e330f5b246cf5c8a063929d034f237f8d178e87'
const REQUEST = {
    requestId: 0n,
    beaconPubKeyHash: '0xF83ADA85DE740DD123163AEF4DF20A378211F9C6F82268151F268A5750040CF4',
    requester: '0x130cb8836bb2a75a420607c2ca4277ecca600ceb',
    round: 222886,
    callbackGasLimit: 500_000,
    beacon: {
        round: 222886,
        randomness: '42c96711c23ed3297570d3a22a73d0a69ff1e383c45c2c97e7d413e5229d5fd6',
        signature:
            '02e97e087b7dbc51899d2618ed82a61e2a4ae5e22210cf294fd51b15f8c348a32cc3c17f0a59fef2e58513b3dc1d36952631eff5749857af2c39ef2bf6575df7',
    },
}

async function main() {
    const [deployer] = await ethers.getSigners()
    const rngesus = await RNGesusReloaded__factory.connect(
        RNGESUS_ADDRESS,
        deployer,
    ).waitForDeployment()

    const { requestId, beaconPubKeyHash, requester, round, callbackGasLimit, beacon } = REQUEST
    const tx = await rngesus
        .fulfillRandomness(
            requestId,
            requester,
            round,
            callbackGasLimit,
            decodeG1(beacon.signature),
        )
        .then((tx) => tx.wait(1))
    console.log(`Confirmed tx: ${tx?.hash}`)
}

main()
    .then(() => {
        console.log('Done')
    })
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })

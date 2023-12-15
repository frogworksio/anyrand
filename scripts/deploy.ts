import { ethers, run } from 'hardhat'
import { RNGesusReloadedConsumer__factory, RNGesusReloaded__factory } from '../typechain-types'
import { parseEther } from 'ethers'
import { DRAND_BN254_INFO, decodeG2 } from '../lib/drand'

const REQUEST_PRICE = parseEther('0.001')

async function main() {
    const [deployer] = await ethers.getSigners()

    const rngesus = await new RNGesusReloaded__factory(deployer)
        .deploy(REQUEST_PRICE)
        .then((tx) => tx.waitForDeployment())
    console.log(`RNGesusReloaded deployed at: ${await rngesus.getAddress()}`)

    // Register beacon
    const publicKey = decodeG2(DRAND_BN254_INFO.public_key)
    const beacon = {
        publicKey,
        period: BigInt(DRAND_BN254_INFO.period),
        genesisTimestamp: BigInt(DRAND_BN254_INFO.genesis_time),
    }
    await rngesus.registerBeacon(beacon)
    const pkh = (await rngesus.hashPubKey(publicKey)) as `0x${string}`
    console.log(`Registered beacon with PKH: ${pkh}`)

    const consumer = await new RNGesusReloadedConsumer__factory(deployer)
        .deploy(await rngesus.getAddress())
        .then((tx) => tx.waitForDeployment())
    console.log(`Consumer deployed at: ${await consumer.getAddress()}`)

    await new Promise((resolve) => setTimeout(resolve, 30_000))
    await run('verify:verify', {
        address: await rngesus.getAddress(),
        constructorArguments: [REQUEST_PRICE],
    })
    await run('verify:verify', {
        address: await consumer.getAddress(),
        constructorArguments: [await rngesus.getAddress()],
    })
}

main()
    .then(() => {
        console.log('Done')
    })
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })

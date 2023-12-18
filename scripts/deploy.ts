import { ethers, run } from 'hardhat'
import { RNGesusReloadedConsumer__factory, RNGesusReloaded__factory } from '../typechain-types'
import { parseEther } from 'ethers'
import { DRAND_BN254_INFO, decodeG2 } from '../lib/drand'

const REQUEST_PRICE = parseEther('0.001')
const MAX_CALLBACK_GAS_LIMIT = 2_000_000

async function main() {
    const [deployer] = await ethers.getSigners()

    const rngesus = await new RNGesusReloaded__factory(deployer)
        .deploy(
            decodeG2(DRAND_BN254_INFO.public_key),
            BigInt(DRAND_BN254_INFO.genesis_time),
            BigInt(DRAND_BN254_INFO.period),
            REQUEST_PRICE,
            MAX_CALLBACK_GAS_LIMIT,
        )
        .then((tx) => tx.waitForDeployment())
    console.log(`RNGesusReloaded deployed at: ${await rngesus.getAddress()}`)

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

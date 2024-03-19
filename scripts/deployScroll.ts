import { ethers, run } from 'hardhat'
import { AnyrandConsumer__factory, AnyrandScroll__factory } from '../typechain-types'
import { parseEther } from 'ethers'
import { DRAND_BN254_INFO, decodeG2 } from '../lib/drand'

const REQUEST_PRICE = parseEther('0.001')
const MAX_CALLBACK_GAS_LIMIT = 2_000_000
const MAX_DEADLINE_DELTA = 1800 // 30 mins into the future

async function main() {
    const [deployer] = await ethers.getSigners()

    const anyrandArgs: Parameters<AnyrandScroll__factory['deploy']> = [
        decodeG2(DRAND_BN254_INFO.public_key),
        BigInt(DRAND_BN254_INFO.genesis_time),
        BigInt(DRAND_BN254_INFO.period),
        REQUEST_PRICE,
        MAX_CALLBACK_GAS_LIMIT,
        MAX_DEADLINE_DELTA,
    ]
    const anyrand = await new AnyrandScroll__factory(deployer)
        .deploy(...anyrandArgs)
        .then((tx) => tx.waitForDeployment())
    console.log(`Anyrand deployed at: ${await anyrand.getAddress()}`)

    const consumerArgs: Parameters<AnyrandConsumer__factory['deploy']> = [
        await anyrand.getAddress(),
    ]
    const consumer = await new AnyrandConsumer__factory(deployer)
        .deploy(...consumerArgs)
        .then((tx) => tx.waitForDeployment())
    console.log(`Consumer deployed at: ${await consumer.getAddress()}`)

    await new Promise((resolve) => setTimeout(resolve, 30_000))
    await run('verify:verify', {
        address: await anyrand.getAddress(),
        constructorArguments: anyrandArgs,
    })
    await run('verify:verify', {
        address: await consumer.getAddress(),
        constructorArguments: consumerArgs,
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

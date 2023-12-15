import { ethers } from 'hardhat'
import { RNGesusReloadedConsumer__factory, RNGesusReloaded__factory } from '../typechain-types'
import { parseEther } from 'ethers'

const REQUEST_PRICE = parseEther('0.001')

async function main() {
    const [deployer] = await ethers.getSigners()

    const rngesus = await new RNGesusReloaded__factory(deployer).deploy(REQUEST_PRICE)
    console.log(`RNGesusReloaded deployed at: ${await rngesus.getAddress()}`)

    const consumer = await new RNGesusReloadedConsumer__factory(deployer).deploy(
        await rngesus.getAddress(),
    )
    console.log(`Consumer deployed at: ${await consumer.getAddress()}`)
}

main()
    .then(() => {
        console.log('Done')
    })
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })

import { formatUnits } from 'ethers'
import { ethers } from 'hardhat'

async function main() {
    const chainId = await ethers.provider.getNetwork().then((network) => network.chainId)
    console.log(`\nchainid: ${chainId}\n`)

    const { gasPrice, maxFeePerGas, maxPriorityFeePerGas } = await ethers.provider.getFeeData()
    console.log(`Gas price:\n\t${formatUnits(gasPrice!, 'gwei')} gwei`)
    console.log(`Max fee per gas:\n\t${formatUnits(maxFeePerGas!, 'gwei')} gwei`)
    console.log(`Max priority fee per gas:\n\t${formatUnits(maxPriorityFeePerGas!, 'gwei')} gwei`)
}

main()
    .then(() => {
        process.exit(0)
    })
    .catch((error) => {
        console.error(error)
        process.exit(1)
    })

import { ethers } from 'hardhat'
import { parseUnits } from 'ethers'

const maxFeePerGas = parseUnits('10', 9)
const maxPriorityFeePerGas = parseUnits('5', 9)

export async function clearTxes() {
    const [deployer] = await ethers.getSigners()
    const pendingNonce = await deployer.getNonce('pending')
    const confirmedNonce = await deployer.getNonce('latest')
    console.log(`Pending nonce: ${pendingNonce}, confirmed nonce: ${confirmedNonce}`)
    for (let i = confirmedNonce; i <= pendingNonce; i++) {
        const tx = await deployer.sendTransaction({
            to: deployer.address,
            value: 0n,
            nonce: i,
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: maxPriorityFeePerGas,
        })
        console.log(`Submitted tx ${tx.hash} with nonce ${i}`)
        const receipt = await tx.wait(1)
        console.log(`Mined in block ${receipt?.blockNumber}`)
    }
}

clearTxes()
    .then(() => {
        console.log('Done')
        process.exit(0)
    })
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })

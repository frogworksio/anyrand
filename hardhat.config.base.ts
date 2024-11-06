import { HardhatUserConfig } from 'hardhat/types'
import config from './hardhat.config'

const configWithNetwork: HardhatUserConfig = {
    ...config,
    defaultNetwork: 'base',
    networks: {
        base: {
            chainId: 8453,
            url: process.env.BASE_URL as string,
            accounts: [process.env.ANYRAND_BASE_DEPLOYER_PK as string],
        },
        baseSepolia: {
            chainId: 84532,
            url: process.env.BASE_SEPOLIA_URL as string,
            accounts: [process.env.ANYRAND_BASE_DEPLOYER_PK as string],
        },
    },
    etherscan: {
        apiKey: {
            base: process.env.BASESCAN_API_KEY as string,
            baseSepolia: process.env.BASESCAN_API_KEY as string,
        },
        customChains: [
            {
                network: 'baseSepolia',
                chainId: 84532,
                urls: {
                    apiURL: 'https://base-sepolia.blockscout.com/api',
                    browserURL: 'https://sepolia-explorer.base.org',
                },
            },
        ],
    },
}

export default configWithNetwork

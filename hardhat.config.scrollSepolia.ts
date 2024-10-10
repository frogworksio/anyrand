import { HardhatUserConfig } from 'hardhat/types'
import config from './hardhat.config'

const configWithNetwork: HardhatUserConfig = {
    ...config,
    defaultNetwork: 'scrollSepolia',
    networks: {
        scrollSepolia: {
            chainId: 534351,
            url: process.env.SCROLL_SEPOLIA_URL as string,
            accounts: [process.env.MAINNET_PK as string],
        },
    },
    etherscan: {
        apiKey: {
            scrollSepolia: process.env.SCROLLSCAN_API_KEY as string,
        },
        customChains: [
            {
                network: 'scrollSepolia',
                chainId: 534351,
                urls: {
                    apiURL: 'https://api-sepolia.scrollscan.com/api',
                    browserURL: 'https://sepolia.scrollscan.dev',
                },
            },
        ],
    },
}

export default configWithNetwork

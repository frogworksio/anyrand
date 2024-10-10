import { HardhatUserConfig } from 'hardhat/types'
import config from './hardhat.config'

const configWithNetwork: HardhatUserConfig = {
    ...config,
    defaultNetwork: 'scroll',
    networks: {
        scroll: {
            chainId: 534352,
            url: process.env.SCROLL_URL as string,
            accounts: [process.env.MAINNET_PK as string],
        },
    },
    etherscan: {
        apiKey: {
            scroll: process.env.SCROLLSCAN_API_KEY as string,
        },
        customChains: [
            {
                network: 'scroll',
                chainId: 534352,
                urls: {
                    apiURL: 'https://api.scrollscan.com/api',
                    browserURL: 'https://scrollscan.com',
                },
            },
        ],
    },
}

export default configWithNetwork

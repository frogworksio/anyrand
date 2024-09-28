import type { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import 'hardhat-storage-layout'
import 'hardhat-contract-sizer'
import 'hardhat-storage-layout-changes'
import 'hardhat-abi-exporter'
import 'hardhat-gas-reporter'
import '@nomicfoundation/hardhat-ignition-ethers'
import * as dotenv from 'dotenv'

dotenv.config()

const config: HardhatUserConfig = {
    solidity: {
        version: '0.8.23',
        settings: {
            viaIR: false,
            optimizer: {
                enabled: true,
                runs: 1000,
            },
        },
    },
    networks: {
        hardhat: {
            chainId: 534352,
            forking: {
                enabled: true,
                url: process.env.SCROLL_URL as string,
                blockNumber: 1592721,
            },
            blockGasLimit: 30_000_000,
            accounts: {
                count: 10,
            },
            gasPrice: 1e9,
        },
        scroll: {
            chainId: 534352,
            url: process.env.SCROLL_URL as string,
            accounts: [process.env.MAINNET_PK as string],
        },
        scrollSepolia: {
            chainId: 534351,
            url: process.env.SCROLL_SEPOLIA_URL as string,
            accounts: [process.env.MAINNET_PK as string],
        },
        sepolia: {
            chainId: 11155111,
            url: process.env.SEPOLIA_URL as string,
            accounts: [process.env.MAINNET_PK as string],
        },
        base: {
            chainId: 8453,
            url: process.env.BASE_URL as string,
            accounts: [process.env.MAINNET_PK as string],
        },
        degen: {
            chainId: 666666666,
            url: process.env.DEGEN_URL as string,
            accounts: [process.env.MAINNET_PK as string],
        },
        gnosis: {
            chainId: 100,
            url: process.env.XDAI_URL as string,
            accounts: [process.env.MAINNET_PK as string],
        },
    },
    gasReporter: {
        enabled: true,
        currency: 'USD',
        gasPrice: 60,
    },
    etherscan: {
        apiKey: {
            mainnet: process.env.ETHERSCAN_API_KEY as string,
            scroll: process.env.SCROLLSCAN_API_KEY as string,
            scrollSepolia: process.env.SCROLLSCAN_API_KEY as string,
            sepolia: process.env.ETHERSCAN_API_KEY as string,
            base: process.env.BASESCAN_API_KEY as string,
            xdai: process.env.GNOSISSCAN_API_KEY as string,
            degen: 'abc', // blockscout
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
            {
                network: 'scrollSepolia',
                chainId: 534351,
                urls: {
                    apiURL: 'https://api-sepolia.scrollscan.com/api',
                    browserURL: 'https://sepolia.scrollscan.dev',
                },
            },
            {
                network: 'degen',
                chainId: 666666666,
                urls: {
                    apiURL: 'https://explorer.degen.tips/api',
                    browserURL: 'https://explorer.degen.tips',
                },
            },
        ],
    },
    contractSizer: {
        alphaSort: true,
        disambiguatePaths: false,
        runOnCompile: false,
        strict: true,
    },
    paths: {
        storageLayouts: '.storage-layouts',
    },
    storageLayoutChanges: {
        contracts: [],
        fullPath: false,
    },
    abiExporter: {
        path: './exported/abi',
        runOnCompile: true,
        clear: true,
        flat: true,
        only: ['Anyrand'],
        except: ['test/*'],
    },
    ignition: {
        blockPollingInterval: 5000,
        requiredConfirmations: 1,
    },
}

export default config

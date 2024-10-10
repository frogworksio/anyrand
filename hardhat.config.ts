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
        version: '0.8.28',
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
            blockGasLimit: 30_000_000,
            accounts: {
                count: 10,
                accountsBalance: '1000000000000000000000000',
            },
            initialBaseFeePerGas: 1,
        },
    },
    gasReporter: {
        enabled: true,
        currency: 'USD',
        gasPrice: 60,
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
        strategyConfig: {
            create2: {
                salt: '0x97248C0ddC583537a824A7ad5Ee92D5f4525bcAa000000000000000000000001',
            },
        },
    },
}

export default config

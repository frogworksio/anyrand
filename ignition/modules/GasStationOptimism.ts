import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('GasStationOptimism', (m) => {
    const gasStationOptimism = m.contract('GasStationOptimism', [])
    return {
        gasStationOptimism,
    }
})

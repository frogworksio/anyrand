import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { DrandBeacon__factory } from '../typechain-types'
import { ethers } from 'hardhat'
import { bn254 } from '@kevincharm/noble-bn254-drand'
import { expect } from 'chai'

describe('DrandBeacon', () => {
    let deployer: SignerWithAddress
    beforeEach(async () => {
        ;[deployer] = await ethers.getSigners()
    })

    it('should deploy with valid configuration', async () => {
        const secretKey = bn254.utils.randomPrivateKey()
        const pubKey = bn254.G2.ProjectivePoint.fromPrivateKey(secretKey)
        const pkAffine = pubKey.toAffine()
        const pk: [bigint, bigint, bigint, bigint] = [
            pkAffine.x.c0,
            pkAffine.x.c1,
            pkAffine.y.c0,
            pkAffine.y.c1,
        ]
        const genesisTimestamp = Math.floor(Date.now() / 1000)
        const period = 3

        const beacon = await new DrandBeacon__factory(deployer).deploy(pk, genesisTimestamp, period)

        expect(await beacon.publicKey()).to.eq(
            `0x${pk.map((p) => p.toString(16).padStart(64, '0')).join('')}`,
        )
        expect(await beacon.genesisTimestamp()).to.eq(genesisTimestamp)
        expect(await beacon.period()).to.eq(period)
    })

    it('should revert with invalid public key', async () => {
        await expect(
            new DrandBeacon__factory(deployer).deploy([0, 0, 0, 0], 0, 0),
        ).to.be.revertedWithCustomError(new DrandBeacon__factory(deployer), 'InvalidPublicKey')
    })

    it('should revert with invalid genesis timestamp', async () => {
        const secretKey = bn254.utils.randomPrivateKey()
        const pubKey = bn254.G2.ProjectivePoint.fromPrivateKey(secretKey)
        const pkAffine = pubKey.toAffine()
        const pk: [bigint, bigint, bigint, bigint] = [
            pkAffine.x.c0,
            pkAffine.x.c1,
            pkAffine.y.c0,
            pkAffine.y.c1,
        ]
        const genesisTimestamp = Math.floor(Date.now() / 1000)
        const period = 3

        await expect(
            new DrandBeacon__factory(deployer).deploy(pk, 0, period),
        ).to.be.revertedWithCustomError(
            new DrandBeacon__factory(deployer),
            'InvalidBeaconConfiguration',
        )

        await expect(
            new DrandBeacon__factory(deployer).deploy(pk, genesisTimestamp, 0),
        ).to.be.revertedWithCustomError(
            new DrandBeacon__factory(deployer),
            'InvalidBeaconConfiguration',
        )
    })
})

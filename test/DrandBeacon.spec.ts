import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { DrandBeacon, DrandBeacon__factory } from '../typechain-types'
import { ethers } from 'hardhat'
import { bn254 } from '@kevincharm/noble-bn254-drand'
import { expect } from 'chai'
import { G2, getHashedRoundMsg, getRound } from './helpers'

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

    describe('verifyBeaconRound', () => {
        let beacon: DrandBeacon
        let secretKey: Uint8Array
        let pubKey: G2
        let pkAffine: ReturnType<G2['toAffine']>
        let genesisTimestamp = BigInt(Math.floor(Date.now() / 1000))
        let period = 3n
        beforeEach(async () => {
            secretKey = bn254.utils.randomPrivateKey()
            pubKey = bn254.G2.ProjectivePoint.fromPrivateKey(secretKey)
            pkAffine = pubKey.toAffine()
            beacon = await new DrandBeacon__factory(deployer).deploy(
                [pkAffine.x.c0, pkAffine.x.c1, pkAffine.y.c0, pkAffine.y.c1],
                genesisTimestamp,
                period,
            )
        })

        it('should verify a valid signature', async () => {
            const round = BigInt(Math.floor(Math.random() * 1000))
            const M = getHashedRoundMsg(round)
            const signature = bn254.signShortSignature(M, secretKey).toAffine()
            await expect(beacon.verifyBeaconRound(round, [signature.x, signature.y])).to.not.be
                .reverted
        })

        it('should revert if signature was signed by the wrong key', async () => {
            const round = BigInt(Math.floor(Math.random() * 1000))
            const M = getHashedRoundMsg(round)
            const wrongSecretKey = bn254.utils.randomPrivateKey()
            const wrongSignature = bn254.signShortSignature(M, wrongSecretKey).toAffine()
            await expect(
                beacon.verifyBeaconRound(round, [wrongSignature.x, wrongSignature.y]),
            ).to.be.revertedWithCustomError(beacon, 'InvalidSignature')
        })

        it('should revert if signature is not a valid G1 point', async () => {
            const round = BigInt(Math.floor(Math.random() * 1000))
            // Valid G1 points are simply (x,y) satisfying y^2 = x^3 + 3 \forall x,y \in F_r
            const invalidSignature: [bigint, bigint] = [2n, 2n]
            await expect(
                beacon.verifyBeaconRound(round, invalidSignature),
            ).to.be.revertedWithCustomError(beacon, 'InvalidSignature')
        })
    })
})

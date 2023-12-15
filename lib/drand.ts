import { getBytes, hexlify } from 'ethers'

export const DRAND_BN254_INFO = {
    public_key:
        '1731c37e5e9d24c748d465dfacdfd0c8ad71150677d0086eba61d96d452a034912a4f6666e59df44dc6a0b2cdcae89137c1a594bdb25be7a2c81f4bf7634763121ebf198e661a8da76492bf629fd63fc8b3e71b9f5a11653e009e84f58bb2fbe2c50f58ab080f8e54f8cc5bc1f591a737f2c611a35cff799df69f38f2d886745',
    period: 1,
    genesis_time: 1702432747,
    hash: 'e566fb7b16fa767962b00ae623ce9fd610b8b2df48ea573c0258f7a5fbf36afd',
    groupHash: 'f5d54bfd6fd0ab42d881c3536ef7a7e0dcd443c51b65c8a67a2f8ba77c8126a8',
    schemeID: 'bls-bn254-unchained-on-g1',
    metadata: {
        beaconID: 'fairy-drand-bn254-dev',
    },
}

export function decodeG2(point: string) {
    const pkBytes = getBytes(`0x${point}`)
    const publicKey = [
        pkBytes.slice(32, 64),
        pkBytes.slice(0, 32),
        pkBytes.slice(96, 128),
        pkBytes.slice(64, 96),
    ].map((pkBuf) => BigInt(hexlify(pkBuf))) as [bigint, bigint, bigint, bigint]
    return publicKey
}

export function decodeG1(point: string) {
    const sigBytes = getBytes(`0x${point}`)
    const sig = [sigBytes.slice(0, 32), sigBytes.slice(32, 64)].map((sigBuf) =>
        BigInt(hexlify(sigBuf)),
    ) as [bigint, bigint]
    return sig
}

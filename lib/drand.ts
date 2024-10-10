import z from 'zod'
import { getBytes, hexlify } from 'ethers'

export const DrandBeaconInfoSchema = z.object({
    public_key: z.string(),
    period: z.number(),
    genesis_time: z.number(),
    genesis_seed: z.string(),
    chain_hash: z.string(),
    scheme: z.string(),
    beacon_id: z.string(),
})
export type DrandBeaconInfo = z.infer<typeof DrandBeaconInfoSchema>

export const DrandBeaconRoundSchema = z.object({
    round: z.number(),
    signature: z.string(),
})
export type DrandBeaconRound = z.infer<typeof DrandBeaconRoundSchema>

export async function getDrandBeaconInfo(beaconId: string) {
    const res = await fetch(`https://api.drand.sh/v2/beacons/${beaconId}/info`)
    if (res.status >= 400) {
        throw new Error(`Failed to get Drand beacon info: ${res.statusText}`)
    }
    return DrandBeaconInfoSchema.parse(await res.json())
}

export async function getDrandBeaconRound(beaconId: string, round: number) {
    const res = await fetch(`https://api.drand.sh/v2/beacons/${beaconId}/rounds/${round}`)
    if (res.status >= 400) {
        throw new Error(`Failed to get Drand beacon info: ${res.statusText}`)
    }
    return DrandBeaconRoundSchema.parse(await res.json())
}

export async function getDrandBeaconLatestRound(beaconId: string) {
    const res = await fetch(`https://api.drand.sh/v2/beacons/${beaconId}/rounds/latest`)
    if (res.status >= 400) {
        throw new Error(`Failed to get Drand beacon info: ${res.statusText}`)
    }
    return DrandBeaconRoundSchema.parse(await res.json())
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

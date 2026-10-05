import crypto from "crypto"
import fs from "fs"
import path from "path"
import { localRealDataDirectory } from "../helpers/local-real-data"

export type RealDataOracle = {
  sha256: string
  sheet: string
  rows: number
  columns: number
  panel: {
    entityVar: string
    timeVar: string
    duplicateEntityTimeRows: number
    compositeEntityColumns?: string[]
    compositeEntities?: number
    duplicateCompositeTimeRows?: number
  }
}

export const REAL_DATA_ORACLES = Object.freeze({
  "did.xlsx": {
    sha256: "1f906de3652b904a1436b1e5169a049ac2bbc948001b072bb2b349b92c7bd5db",
    sheet: "Data_可读",
    rows: 4_709,
    columns: 34,
    panel: {
      entityVar: "地区",
      timeVar: "year",
      duplicateEntityTimeRows: 0,
    },
  },
  "did_stage000.csv": {
    sha256: "087c5d993a9d42a7dfcf6d11900244bfaadc946bd63207ad66f00cedc652b601",
    sheet: "did_stage000",
    rows: 4_709,
    columns: 34,
    panel: {
      entityVar: "地区",
      timeVar: "year",
      duplicateEntityTimeRows: 0,
    },
  },
  "gf.xlsx": {
    sha256: "1267c12c512cdf0d42eeb3bb722b89c2f52ce7d75a55c4ecb6bf47bac632deb6",
    sheet: "Sheet1",
    rows: 9_545,
    columns: 11,
    panel: {
      entityVar: "地区",
      timeVar: "年份",
      duplicateEntityTimeRows: 0,
    },
  },
  "test_datasets.xlsx": {
    sha256: "a001c91e746b69d37cb3beeb46b1059065691fa532cb65b1e462eb4c10a02927",
    sheet: "Sheet1",
    rows: 9_683,
    columns: 8,
    panel: {
      entityVar: "地区",
      timeVar: "年份",
      duplicateEntityTimeRows: 115,
      compositeEntityColumns: ["省份", "地区"],
      compositeEntities: 421,
      duplicateCompositeTimeRows: 0,
    },
  },
}) satisfies Readonly<Record<string, RealDataOracle>>

export function realDataOracleFilePath(file: keyof typeof REAL_DATA_ORACLES, dataDirectory = localRealDataDirectory()) {
  return path.join(dataDirectory, file)
}

export function validateRealDataOracle(
  file: keyof typeof REAL_DATA_ORACLES,
  dataDirectory?: string,
) {
  const expected = REAL_DATA_ORACLES[file]
  const filepath = realDataOracleFilePath(file, dataDirectory)
  if (!fs.existsSync(filepath)) return [`数据文件不存在：${filepath}`]
  const digest = crypto.createHash("sha256").update(fs.readFileSync(filepath)).digest("hex")
  return digest === expected.sha256
    ? []
    : [`数据文件指纹漂移：${file} expected=${expected.sha256} actual=${digest}`]
}

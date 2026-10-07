import fs from "fs"
import path from "path"

/** Real workbooks stay local/ignored; tests use a private fixture directory when configured. */
export const localRealDataDirectory = () =>
  process.env.KILLSTATA_TEST_DATA_DIR?.trim() || path.resolve(process.cwd(), "../..", "data")

export const localRealDataPath = (file: string) => path.join(localRealDataDirectory(), file)

export const hasLocalRealData = (...files: string[]) =>
  files.every((file) => fs.existsSync(localRealDataPath(file)))

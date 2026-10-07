import { Share } from "../share/share"
import { File } from "../file"
import { Instance } from "./instance"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Truncate } from "../tool/truncation"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  Share.init()
  ShareNext.init()
  File.init()
  Truncate.init()
}

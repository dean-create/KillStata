import { createMemo } from "solid-js"
import { useSync } from "./sync"
import { Global } from "@/global"

export function useDirectory() {
  const { data } = useSync()
  return createMemo(() => {
    const directory = data.path.directory || process.cwd()
    return directory.replace(Global.Path.home, "~")
  })
}

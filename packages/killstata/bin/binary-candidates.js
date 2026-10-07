export function linuxLibcFromNodeReport(report) {
  const version = report?.header?.glibcVersionRuntime
  return typeof version === "string" && version.length > 0 ? "glibc" : undefined
}

export function installedBinaryPackageNames(platformName, architecture, { libc } = {}) {
  const platform = platformName === "win32" ? "windows" : platformName
  const arch = architecture === "x64" || architecture === "arm64" ? architecture : "x64"

  if (platform === "linux") {
    const native = `killstata-${platform}-${arch}`
    const musl = `${native}-musl`
    const glibcVariants = arch === "x64" ? [native, `${native}-baseline`] : [native]
    const muslVariants = arch === "x64" ? [musl, `${native}-baseline-musl`] : [musl]
    return libc === "glibc" ? [...glibcVariants, ...muslVariants] : [...muslVariants, ...glibcVariants]
  }

  const names = [`killstata-${platform}-${arch}`]
  if (arch === "x64") names.push(`killstata-${platform}-${arch}-baseline`)
  return names
}

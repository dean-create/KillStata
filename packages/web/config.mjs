const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://killstata.ai" : `https://${stage}.killstata.ai`,
  console: stage === "production" ? "https://killstata.ai/auth" : `https://${stage}.killstata.ai/auth`,
  email: "contact@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/anomalyco/killstata",
  discord: "https://killstata.ai/discord",
  headerLinks: [
    { name: "Home", url: "/" },
    { name: "Docs", url: "/docs/" },
  ],
}

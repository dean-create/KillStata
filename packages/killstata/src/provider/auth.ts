import { Instance } from "@/project/instance"
import z from "zod"
import { fn } from "@killstata/util/fn"
import { Auth } from "../auth"
import { deepSeekEnvOnlyAuthMessage } from "./deepseek-policy"
import { allowedProvidersMessage, isAllowedProvider } from "./model-policy"

export namespace ProviderAuth {
  export const Method = z
    .object({
      type: z.union([z.literal("oauth"), z.literal("api")]),
      label: z.string(),
    })
    .meta({
      ref: "ProviderAuthMethod",
    })
  export type Method = z.infer<typeof Method>

  export async function methods() {
    return {}
  }

  export const Authorization = z
    .object({
      url: z.string(),
      method: z.union([z.literal("auto"), z.literal("code")]),
      instructions: z.string(),
    })
    .meta({
      ref: "ProviderAuthAuthorization",
    })
  export type Authorization = z.infer<typeof Authorization>

  export const authorize = fn(
    z.object({
      providerID: z.string(),
      method: z.number(),
    }),
    async (input): Promise<Authorization | undefined> => {
      throw new Error(deepSeekEnvOnlyAuthMessage(input.providerID))
    },
  )

  export const callback = fn(
    z.object({
      providerID: z.string(),
      method: z.number(),
      code: z.string().optional(),
    }),
    async (input) => {
      throw new Error(deepSeekEnvOnlyAuthMessage(input.providerID))
    },
  )

  export const api = fn(
    z.object({
      providerID: z.string(),
      key: z.string(),
    }),
    async (input) => {
      if (!isAllowedProvider(input.providerID)) {
        throw new Error(allowedProvidersMessage(input.providerID))
      }
      await Auth.set(input.providerID, {
        type: "api",
        key: input.key,
      })
      // /connect 保存密钥后，清掉当前项目实例缓存，后续模型调用会重新读取 auth.json。
      await Instance.dispose()
    },
  )
}

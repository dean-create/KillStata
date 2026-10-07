import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Instance } from "../../project/instance"
import { lazy } from "@killstata/util/lazy"
import { findDataFiles } from "@/data/file-discovery"

/** 仅服务导入与补全的数据文件接口，不暴露通用代码仓库浏览。 */
export const DataRoutes = lazy(() =>
  new Hono().get(
    "/files",
    describeRoute({
      summary: "Find importable data files",
      description: "List CSV, Excel, and Stata files that KillStata can import from the current project.",
      operationId: "data.files",
      responses: {
        200: {
          description: "Relative data file paths",
          content: { "application/json": { schema: resolver(z.string().array()) } },
        },
      },
    }),
    validator(
      "query",
      z.object({ query: z.string().optional().default(""), limit: z.coerce.number().int().min(1).max(200).optional() }),
    ),
    async (context) => {
      const input = context.req.valid("query")
      return context.json(await findDataFiles({ root: Instance.worktree, query: input.query, limit: input.limit }))
    },
  ),
)

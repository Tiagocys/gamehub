import { onRequestGet as __og_listing__id__js_onRequestGet } from "/home/gamehub/functions/og/listing/[id].js"

export const routes = [
    {
      routePath: "/og/listing/:id",
      mountPath: "/og/listing",
      method: "GET",
      middlewares: [],
      modules: [__og_listing__id__js_onRequestGet],
    },
  ]
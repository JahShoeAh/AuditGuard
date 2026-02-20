import { handleRequest } from "./src/app";
import type { RuntimeEnv } from "./src/types/runtime";

export default {
  fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};

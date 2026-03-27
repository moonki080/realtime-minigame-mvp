import { routeApiRequest } from "../lib/simple-game-api.mjs";

export default async function handler(request, response) {
  await routeApiRequest(request, response);
}

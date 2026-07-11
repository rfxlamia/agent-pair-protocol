import { afterEach } from "vitest";
import { resetInitiatorCompletionsForTests } from "./src/tools/pair-completion.js";

afterEach(() => {
  resetInitiatorCompletionsForTests();
});

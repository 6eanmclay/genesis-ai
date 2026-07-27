import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      // Family-beta instrumentation (v20): an ephemeral id minted once per
      // real sign-in (never per-tab/per-request), used only to group
      // ProductEvent rows into "one sitting" — see auth.ts's jwt callback.
      sessionInstanceId: string;
    } & DefaultSession["user"];
  }
}

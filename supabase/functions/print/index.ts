import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";
import { createPrintHandler } from "./handler.mjs";

Deno.serve(createPrintHandler({ createClient, env: Deno.env }));

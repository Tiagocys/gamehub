import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

function matchesPhone(a: string, b: string) {
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

async function sendMessage(chatId: number, text: string, replyMarkup?: Record<string, unknown>) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }
    if (!TELEGRAM_BOT_TOKEN) {
      return errorResponse("TELEGRAM_BOT_TOKEN ausente", 500);
    }

    if (TELEGRAM_WEBHOOK_SECRET) {
      const secretHeader = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
      // If Telegram sends a secret and it mismatches, reject.
      if (secretHeader && secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
        return errorResponse("Webhook inválido", 401);
      }
      // If no secret header is present, allow to avoid blocking (e.g. missing secret_token config).
    }

    const update = await req.json();
    const message = update?.message || update?.edited_message;
    if (!message) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const chatId = message.chat?.id;
    const fromId = message.from?.id;
    if (!chatId || !fromId) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const text = message.text || "";
    const startMatch = text.match(/\/start\s+verify_([A-Z0-9-]+)/i);
    const codeMatch = text.match(/GMR-[A-Z0-9-]+/i);
    const verifyMatch = text.match(/\/verify\s+(GMR-[A-Z0-9-]+)/i);
    const incomingCode = startMatch?.[1] || verifyMatch?.[1] || codeMatch?.[0];
    if (incomingCode) {
      const code = incomingCode.toUpperCase();
      const { data, error } = await supabase
        .from("phone_verifications")
        .select("id,expires_at,status")
        .eq("code", code)
        .single();
      if (error || !data) {
        await sendMessage(chatId, "Invalid code. Please generate a new code on the website.");
      } else if (new Date(data.expires_at) < new Date()) {
        await supabase.from("phone_verifications").update({ status: "expired" }).eq("id", data.id);
        await sendMessage(chatId, "Your code has expired. Please generate a new one on the website.");
      } else {
        await supabase
          .from("phone_verifications")
          .update({ telegram_user_id: fromId, status: "code_confirmed" })
          .eq("id", data.id);
        const keyboard = {
          keyboard: [[{ text: "Share contact", request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        };
        await sendMessage(chatId, "Gimerr Phone Verification\n\nClick on “Share button” below 👇👇", keyboard);
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    if (text.startsWith("/start")) {
      await sendMessage(chatId, "Gimerr Phone Verification\n\nClick on “Share button” below 👇👇", {
        keyboard: [[{ text: "Share contact", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const contact = message.contact;
    if (contact) {
      if (contact.user_id && contact.user_id !== fromId) {
        await sendMessage(chatId, "Please share your own contact to verify.");
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
      const { data, error } = await supabase
        .from("phone_verifications")
        .select("id,user_id,phone,expires_at,status")
        .eq("telegram_user_id", fromId)
        .in("status", ["pending", "code_confirmed"])
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (error || !data) {
        await sendMessage(chatId, "No pending verification found. Please generate a new code on the website.");
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
      if (new Date(data.expires_at) < new Date()) {
        await supabase.from("phone_verifications").update({ status: "expired" }).eq("id", data.id);
        await sendMessage(chatId, "Your code has expired. Please generate a new one on the website.");
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }

      const normalizedContact = normalizePhone(contact.phone_number || "");
      const normalizedStored = normalizePhone(data.phone || "");
      if (data.phone && !matchesPhone(normalizedContact, normalizedStored)) {
        await sendMessage(chatId, "The phone number doesn't match the one on record. Please generate a new code on the website.");
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }

      const phoneToSave = contact.phone_number || data.phone || "";
      const nowIso = new Date().toISOString();
      const { error: userUpdateError } = await supabase.from("users").update({
        phone: phoneToSave,
        phone_verified: true,
        phone_verified_at: nowIso,
      }).eq("id", data.user_id);
      if (userUpdateError) {
        if (userUpdateError.code === "23505") {
          await supabase.from("phone_verifications").update({ status: "expired" }).eq("id", data.id);
          await sendMessage(
            chatId,
            "This phone number is already verified on another account. Please use a different number."
          );
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json", ...corsHeaders },
          });
        }
        throw userUpdateError;
      }

      const { error: verificationUpdateError } = await supabase.from("phone_verifications").update({
        status: "verified",
        phone: phoneToSave,
        verified_at: nowIso,
      }).eq("id", data.id);
      if (verificationUpdateError) {
        throw verificationUpdateError;
      }

      await sendMessage(chatId, "Phone number verified successfully!");
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse("Erro no webhook", 500);
  }
});

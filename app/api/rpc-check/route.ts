import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const rpcUrl = process.env.LINEA_RPC_URL;

  if (!rpcUrl) {
    return NextResponse.json(
      { error: "LINEA_RPC_URL env var is missing" },
      { status: 500 }
    );
  }

  try {
    // Basic eth_chainId call
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    };

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await res.text();

    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      rpcUrlUsed: rpcUrl,
      responseText: text,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        error: "RPC request failed",
        details: err?.message || String(err),
        rpcUrlUsed: rpcUrl,
      },
      { status: 500 }
    );
  }
}

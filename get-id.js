const { create } = require("@wppconnect-team/wppconnect");

async function main() {
  try {
    const client = await create({
      session: "monitor-session",
      autoClose: false,
      logQR: true,
      headless: false
    });

    const groups = await client.listChats({ onlyGroups: true });

    console.log("\n=== GRUPOS DE WHATSAPP ===");
    groups.forEach((group, index) => {
      const id = group?.id?._serialized || group?.id;
      const name = group?.name || group?.formattedTitle || "(sin nombre)";
      console.log(`${index + 1}. ${name} => ${id}`);
    });

    console.log("\nCopia el ID que termina en @g.us y pegalo en WHATSAPP_GROUP_ID.");
  } catch (error) {
    console.error("Error:", error.message || error);
  }
}

main();



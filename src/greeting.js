export function createGreeting(name) {
  if (!name || typeof name !== "string") {
    throw new Error("Name is required");
  }

  return `Hello, ${name}!`;
}

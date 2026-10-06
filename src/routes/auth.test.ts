import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRegistrationInput } from "./auth.js";
import { hasPermission, hasRole, normalizePermissions } from "../utils/authSession.js";

test("normalise les champs du formulaire de création de compte", () => {
  assert.deepEqual(normalizeRegistrationInput({
    firstName: " Marie ",
    lastName: " Rakoto ",
    email: " MARIE@EXAMPLE.COM ",
    phone: " 0340000000 ",
    password: "secure-password",
  }), {
    name: "Marie",
    lastName: "Rakoto",
    email: "marie@example.com",
    tel: "0340000000",
    password: "secure-password",
  });
});

test("préserve le contrat historique name/tel", () => {
  assert.deepEqual(normalizeRegistrationInput({ name: "Marie", lastName: "Rakoto", email: "M@EXAMPLE.COM", tel: "034" }), {
    name: "Marie",
    lastName: "Rakoto",
    email: "m@example.com",
    tel: "034",
    password: "",
  });
});

test("normalise les permissions JSON en tableau exploitable", () => {
  assert.deepEqual(normalizePermissions('["reservations:read","users:write"]'), ["reservations:read", "users:write"]);
  assert.deepEqual(normalizePermissions(["reservations:read", "users:write"]), ["reservations:read", "users:write"]);
  assert.deepEqual(normalizePermissions(undefined), []);
});

test("détermine rapidement les rôles et permissions d’un utilisateur", () => {
  const user = { role: "Propriétaire", permissions: ["reservations:read", "users:write"] };
  assert.equal(hasRole(user, "Propriétaire", "Agent"), true);
  assert.equal(hasRole(user, "Agent"), false);
  assert.equal(hasPermission(user, "reservations:read"), true);
  assert.equal(hasPermission(user, "boats:delete"), false);
});
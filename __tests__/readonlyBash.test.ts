import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyBashCommand } from "../gate";

describe("isReadOnlyBashCommand — find escapes are blocked", () => {
  for (const arg of ["-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprint0", "-printf", "-delete"]) {
    it(`blocks find ${arg} (command/file write escape)`, () => {
      assert.equal(isReadOnlyBashCommand(`find . ${arg} rm {} \\\;`), false, arg);
      assert.equal(isReadOnlyBashCommand(`find . -name x ${arg} /tmp/out`), false, arg);
    });
  }
  it("allows plain read-only find (no dangerous args)", () => {
    assert.equal(isReadOnlyBashCommand("find . -name '*.ts'"), true);
    assert.equal(isReadOnlyBashCommand("find . -type f -print"), true);
    assert.equal(isReadOnlyBashCommand("find . -print0"), true);
  });
});

describe("isReadOnlyBashCommand — non-git read-only commands", () => {
  for (const cmd of ["tree", "tree -L 2", "echo hello", "printf '%s' x", "test -f x", "stat x", "which node", "file x", "du -sh .", "df -h"]) {
    it(`allows ${cmd}`, () => {
      assert.equal(isReadOnlyBashCommand(cmd), true);
    });
  }
});

describe("isReadOnlyBashCommand — redirection still blocked", () => {
  it("blocks echo with redirect", () => {
    assert.equal(isReadOnlyBashCommand("echo x > file"), false);
  });
});

describe("isReadOnlyBashCommand — git branch read/write boundary", () => {
  it("allows git branch -v / -a / -r / --list", () => {
    assert.equal(isReadOnlyBashCommand("git branch -v"), true);
    assert.equal(isReadOnlyBashCommand("git branch -a"), true);
    assert.equal(isReadOnlyBashCommand("git branch -r"), true);
    assert.equal(isReadOnlyBashCommand("git branch --list"), true);
  });
  it("blocks git branch -D / -d / -m (destructive)", () => {
    assert.equal(isReadOnlyBashCommand("git branch -D main"), false);
    assert.equal(isReadOnlyBashCommand("git branch -d feature"), false);
    assert.equal(isReadOnlyBashCommand("git branch -m newname"), false);
  });
  it("blocks git branch <name> (create)", () => {
    assert.equal(isReadOnlyBashCommand("git branch newbranch"), false);
  });
});

describe("isReadOnlyBashCommand — git remote read/write boundary", () => {
  it("allows git remote -v / show", () => {
    assert.equal(isReadOnlyBashCommand("git remote -v"), true);
    assert.equal(isReadOnlyBashCommand("git remote show origin"), true);
  });
  it("blocks git remote add / remove / set-url", () => {
    assert.equal(isReadOnlyBashCommand("git remote add origin url"), false);
    assert.equal(isReadOnlyBashCommand("git remote remove origin"), false);
    assert.equal(isReadOnlyBashCommand("git remote set-url origin url"), false);
  });
});

describe("isReadOnlyBashCommand — git tag read/write boundary", () => {
  it("allows git tag (no args = list) / -l / --list / -n5", () => {
    assert.equal(isReadOnlyBashCommand("git tag"), true);
    assert.equal(isReadOnlyBashCommand("git tag -l"), true);
    assert.equal(isReadOnlyBashCommand("git tag --list"), true);
    assert.equal(isReadOnlyBashCommand("git tag -n5"), true);
  });
  it("blocks git tag <name> (create) / -d (delete)", () => {
    assert.equal(isReadOnlyBashCommand("git tag v1.0"), false);
    assert.equal(isReadOnlyBashCommand("git tag -d v1.0"), false);
  });
});

describe("isReadOnlyBashCommand — git config read/write boundary", () => {
  it("allows git config --get / --get-all / --get-regexp / -l / --list", () => {
    assert.equal(isReadOnlyBashCommand("git config --get user.name"), true);
    assert.equal(isReadOnlyBashCommand("git config --get-all core.ignorecase"), true);
    assert.equal(isReadOnlyBashCommand("git config --get-regexp user"), true);
    assert.equal(isReadOnlyBashCommand("git config -l"), true);
    assert.equal(isReadOnlyBashCommand("git config --list"), true);
  });
  it("blocks git config <key> <value> / --add / --unset", () => {
    assert.equal(isReadOnlyBashCommand("git config user.name X"), false);
    assert.equal(isReadOnlyBashCommand("git config --add user.name X"), false);
    assert.equal(isReadOnlyBashCommand("git config --unset user.name"), false);
  });
});

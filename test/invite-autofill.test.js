const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function source(file) {
  return readFileSync(join(__dirname, '../src', file), 'utf8')
}

test('invite and room name unmount before password autofill', () => {
  const code = source('Dialogs.tsx')
  const tree = ts.createSourceFile('Dialogs.tsx', code, ts.ScriptTarget.Latest, true)
  const fields = {}

  function visit(node) {
    if (ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText()
      const invite = node.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText() === 'label' &&
          attribute.initializer?.text === 'ROOM INVITE'
      )
      if (invite || tag === 'RoomDetails' || tag === 'KeyCredentials') {
        let parent = node.parent
        while (parent && !ts.isJsxExpression(parent)) parent = parent.parent
        const condition = parent?.expression?.left?.getText()
        if (invite) {
          fields.invite = condition
          assert.match(node.attributes.getText(), /autoComplete=['"]off['"]/)
        }
        if (tag === 'RoomDetails') fields.name = condition
        if (tag === 'KeyCredentials') fields.password = condition
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(tree)
  assert.equal(fields.invite, "kind === 'join' && !inviteDrive")
  assert.equal(fields.name, fields.invite)
  assert.equal(fields.password, 'needsPassword && !busy')
  assert.match(code, /kind === 'join' && !!inviteDrive\)\) && state\.profile\?\.encrypted/)
  const nativeField = source('ui.tsx')
  assert.match(nativeField, /textContentType=\{autoComplete === 'off' \? 'none'/)
  assert.match(nativeField, /importantForAutofill=\{autoComplete === 'off' \? 'no'/)
})

const assert = require('assert')
const Automerge = process.env.TEST_DIST === '1' ? require('../dist/automerge') : require('../src/automerge')
const { assertEqualsOneOf } = require('./helpers')

function attributeStateToAttributes(accumulatedAttributes) {
  const attributes = {}
  Object.entries(accumulatedAttributes).forEach(([key, values]) => {
    if (values.length) {
      attributes[key] = values[0]
    }
  })
  return attributes
}

function isEquivalent(a, b) {
  var aProps = Object.getOwnPropertyNames(a);
  var bProps = Object.getOwnPropertyNames(b);

  if (aProps.length != bProps.length) {
      return false;
  }

  for (var i = 0; i < aProps.length; i++) {
      var propName = aProps[i];
      if (a[propName] !== b[propName]) {
          return false;
      }
  }

  return true;
}

function opFrom(text, attributes) {
  let op = { insert: text }
  if (Object.keys(attributes).length > 0) {
      op.attributes = attributes
  }
  return op
}

function accumulateAttributes(span, accumulatedAttributes) {
  Object.entries(span).forEach(([key, value]) => {
    if (!accumulatedAttributes[key]) {
      accumulatedAttributes[key] = []
    }
    if (value === null) {
      accumulatedAttributes[key].shift()
    } else {
      accumulatedAttributes[key].unshift(value)
    }
  })
  return accumulatedAttributes
}

function AutomergeTextToDeltaDoc(text) {
  let ops = []
  let controlState = {}
  let currentString = ""
  let attributes = {}
  text.toSpans().forEach((span) => {
    if (typeof span === 'string') {
      let next = attributeStateToAttributes(controlState)

      if (isEquivalent(next, attributes)) {
        currentString = currentString + span
      } else {
        if (currentString) {
          ops.push(opFrom(currentString, attributes))
        }
        attributes = next
        currentString = span
      } 
    } else {
      controlState = accumulateAttributes(span, controlState)
    }
  })

  // at the end, flush any accumulated string out
  if (currentString) {
    ops.push(opFrom(currentString, attributes))
  }

  let deltaDoc = { ops }
  return deltaDoc
}

function inverseAttributes(attributes) {
  let invertedAttributes = {}
  Object.keys(attributes).forEach((key) => {
    invertedAttributes[key] = null
  })
  return invertedAttributes
}

// XXX: uhhhhh, why can't I pass in text?
function ApplyDeltaToAutomergeText(delta, doc) {
  let offset = 0

  let ops = delta.ops
  if (ops && ops.length) {
    ops.forEach(op => {
      // console.log(doc.text.length, doc.text.slice(0, offset).join('') + "|" + doc.text.slice(offset).join(''), op)
      if (op.retain) {
        offset += op.retain
      } else if (op.delete) {
        doc.text.deleteAt(offset, op.delete)
      } else if (op.insert) {
        doc.text.insertAt(offset, ...op.insert.split(''))
        if (op.attributes) {
          doc.text.insertAt(offset, op.attributes)
          offset += 1
        }
        offset += op.insert.length // +1 for good luck and the control character
        if (op.attributes) {
          doc.text.insertAt(offset, inverseAttributes(op.attributes))
          offset += 1
        }
      }
    })
  }
  console.log("After:", doc.text.toString())
}

describe('Automerge.Text', () => {
  let s1, s2
  beforeEach(() => {
    s1 = Automerge.change(Automerge.init(), doc => doc.text = new Automerge.Text())
    s2 = Automerge.merge(Automerge.init(), s1)
  })

  it('should support insertion', () => {
    s1 = Automerge.change(s1, doc => doc.text.insertAt(0, 'a'))
    assert.strictEqual(s1.text.length, 1)
    assert.strictEqual(s1.text.get(0), 'a')
    assert.strictEqual(s1.text.toString(), 'a')
  })

  it('should support deletion', () => {
    s1 = Automerge.change(s1, doc => doc.text.insertAt(0, 'a', 'b', 'c'))
    s1 = Automerge.change(s1, doc => doc.text.deleteAt(1, 1))
    assert.strictEqual(s1.text.length, 2)
    assert.strictEqual(s1.text.get(0), 'a')
    assert.strictEqual(s1.text.get(1), 'c')
    assert.strictEqual(s1.text.toString(), 'ac')
  })

  it('should handle concurrent insertion', () => {
    s1 = Automerge.change(s1, doc => doc.text.insertAt(0, 'a', 'b', 'c'))
    s2 = Automerge.change(s2, doc => doc.text.insertAt(0, 'x', 'y', 'z'))
    s1 = Automerge.merge(s1, s2)
    assert.strictEqual(s1.text.length, 6)
    assertEqualsOneOf(s1.text.toString(), 'abcxyz', 'xyzabc')
    assertEqualsOneOf(s1.text.join(''), 'abcxyz', 'xyzabc')
  })

  it('should handle text and other ops in the same change', () => {
    s1 = Automerge.change(s1, doc => {
      doc.foo = 'bar'
      doc.text.insertAt(0, 'a')
    })
    assert.strictEqual(s1.foo, 'bar')
    assert.strictEqual(s1.text.toString(), 'a')
    assert.strictEqual(s1.text.join(''), 'a')
  })

  it('should serialize to JSON as a simple string', () => {
    s1 = Automerge.change(s1, doc => doc.text.insertAt(0, 'a', '"', 'b'))
    assert.strictEqual(JSON.stringify(s1), '{"text":"a\\"b"}')
  })

  it('should allow modification before an object is assigned to a document', () => {
    s1 = Automerge.change(Automerge.init(), doc => {
      const text = new Automerge.Text()
      text.insertAt(0, 'a', 'b', 'c', 'd')
      text.deleteAt(2)
      doc.text = text
      assert.strictEqual(doc.text.toString(), 'abd')
      assert.strictEqual(doc.text.join(''), 'abd')
    })
    assert.strictEqual(s1.text.toString(), 'abd')
    assert.strictEqual(s1.text.join(''), 'abd')
  })

  it('should allow modification after an object is assigned to a document', () => {
    s1 = Automerge.change(Automerge.init(), doc => {
      const text = new Automerge.Text()
      doc.text = text
      text.insertAt(0, 'a', 'b', 'c', 'd')
      text.deleteAt(2)
      assert.strictEqual(doc.text.toString(), 'abd')
      assert.strictEqual(doc.text.join(''), 'abd')
    })
    assert.strictEqual(s1.text.join(''), 'abd')
  })

  it('should not allow modification outside of a change callback', () => {
    assert.throws(() => s1.text.insertAt(0, 'a'), /Text object cannot be modified outside of a change block/)
  })

  describe('with initial value', () => {
    it('should accept a string as initial value', () => {
      let s1 = Automerge.change(Automerge.init(), doc => doc.text = new Automerge.Text('init'))
      assert.strictEqual(s1.text.length, 4)
      assert.strictEqual(s1.text.get(0), 'i')
      assert.strictEqual(s1.text.get(1), 'n')
      assert.strictEqual(s1.text.get(2), 'i')
      assert.strictEqual(s1.text.get(3), 't')
      assert.strictEqual(s1.text.toString(), 'init')
    })

    it('should accept an array as initial value', () => {
      let s1 = Automerge.change(Automerge.init(), doc => doc.text = new Automerge.Text(['i', 'n', 'i', 't']))
      assert.strictEqual(s1.text.length, 4)
      assert.strictEqual(s1.text.get(0), 'i')
      assert.strictEqual(s1.text.get(1), 'n')
      assert.strictEqual(s1.text.get(2), 'i')
      assert.strictEqual(s1.text.get(3), 't')
      assert.strictEqual(s1.text.toString(), 'init')
    })

    it('should initialize text in Automerge.from()', () => {
      let s1 = Automerge.from({text: new Automerge.Text('init')})
      assert.strictEqual(s1.text.length, 4)
      assert.strictEqual(s1.text.get(0), 'i')
      assert.strictEqual(s1.text.get(1), 'n')
      assert.strictEqual(s1.text.get(2), 'i')
      assert.strictEqual(s1.text.get(3), 't')
      assert.strictEqual(s1.text.toString(), 'init')
    })

    it('should encode the initial value as a change', () => {
      const s1 = Automerge.from({text: new Automerge.Text('init')})
      const changes = Automerge.getChanges(Automerge.init(), s1)
      assert.strictEqual(changes.length, 1)
      const s2 = Automerge.applyChanges(Automerge.init(), changes)
      assert.strictEqual(s2.text instanceof Automerge.Text, true)
      assert.strictEqual(s2.text.toString(), 'init')
      assert.strictEqual(s2.text.join(''), 'init')
    })

    it('should allow immediate access to the value', () => {
      let s1 = Automerge.change(Automerge.init(), doc => {
        const text = new Automerge.Text('init')
        assert.strictEqual(text.length, 4)
        assert.strictEqual(text.get(0), 'i')
        assert.strictEqual(text.toString(), 'init')
        doc.text = text
        assert.strictEqual(doc.text.length, 4)
        assert.strictEqual(doc.text.get(0), 'i')
        assert.strictEqual(doc.text.toString(), 'init')
      })
    })

    it('should allow pre-assignment modification of the initial value', () => {
      let s1 = Automerge.change(Automerge.init(), doc => {
        const text = new Automerge.Text('init')
        text.deleteAt(3)
        assert.strictEqual(text.join(''), 'ini')
        doc.text = text
        assert.strictEqual(doc.text.join(''), 'ini')
        assert.strictEqual(doc.text.toString(), 'ini')
      })
      assert.strictEqual(s1.text.toString(), 'ini')
      assert.strictEqual(s1.text.join(''), 'ini')
    })

    it('should allow post-assignment modification of the initial value', () => {
      let s1 = Automerge.change(Automerge.init(), doc => {
        const text = new Automerge.Text('init')
        doc.text = text
        text.deleteAt(0)
        doc.text.insertAt(0, 'I')
        assert.strictEqual(text.join(''), 'Init')
        assert.strictEqual(text.toString(), 'Init')
        assert.strictEqual(doc.text.join(''), 'Init')
        assert.strictEqual(doc.text.toString(), 'Init')
      })
      assert.strictEqual(s1.text.join(''), 'Init')
      assert.strictEqual(s1.text.toString(), 'Init')
    })
  })

  describe('non-textual control characters', () => {
    let s1
    beforeEach(() => {
      s1 = Automerge.change(Automerge.init(), doc => {
        doc.text = new Automerge.Text()
        doc.text.insertAt(0, 'a')
        doc.text.insertAt(1, { attribute: 'bold' })
      })
    })

    it('should allow fetching non-textual characters', () => {
      assert.deepEqual(s1.text.get(1), { attribute: 'bold' })
    })

    it('should include control characters in string length', () => {
      assert.strictEqual(s1.text.length, 2)
      assert.strictEqual(s1.text.get(0), 'a')
    })

    it('should exclude control characters from toString()', () => {
      assert.strictEqual(s1.text.toString(), 'a')
    })

    describe('spans interface to Text', () => {
      it('should return a simple string as a single span', () =>{
        let s1 = Automerge.change(Automerge.init(), doc => {
          doc.text = new Automerge.Text('hello world')
        })
        assert.deepEqual(s1.text.toSpans(), ['hello world'])
      })
      it('should return an empty string as an empty array', () =>{
        let s1 = Automerge.change(Automerge.init(), doc => {
          doc.text = new Automerge.Text()
        })
        assert.deepEqual(s1.text.toSpans(), [])
      })
      it('should split a span at a control character', () => {
        let s1 = Automerge.change(Automerge.init(), doc => {
          doc.text = new Automerge.Text('hello world')
          doc.text.insertAt(5, {attribute: 'bold'})
        })
        assert.deepEqual(s1.text.toSpans(), 
          ['hello', {attribute: 'bold'}, ' world'])
      })
      it('should allow consecutive control characters', () => {
        let s1 = Automerge.change(Automerge.init(), doc => {
          doc.text = new Automerge.Text('hello world')
          doc.text.insertAt(5, {attribute: 'bold'})
          doc.text.insertAt(6, {attribute: 'italic'})
        })
        assert.deepEqual(s1.text.toSpans(), 
          ['hello', 
           { attribute: 'bold' }, 
           { attribute: 'italic' },
           ' world'
          ])
      })
      it('should allow non-consecutive control characters', () => {
        let s1 = Automerge.change(Automerge.init(), doc => {
          doc.text = new Automerge.Text('hello world')
          doc.text.insertAt(5, {attribute: 'bold'})
          doc.text.insertAt(12, {attribute: 'italic'})
        })
        assert.deepEqual(s1.text.toSpans(), 
          ['hello', 
           { attribute: 'bold' }, 
           ' world',
           { attribute: 'italic' },
          ])
      })

      it('should be convertable into a Quill delta', () => {
        let s1 = Automerge.change(Automerge.init(), doc => {
          doc.text = new Automerge.Text('Gandalf the Grey')
          doc.text.insertAt(0,  { bold: true })
          doc.text.insertAt(7+1, { bold: null })
          doc.text.insertAt(12+2, { color: '#cccccc' })
        })

        let deltaDoc = AutomergeTextToDeltaDoc(s1.text)

        // From https://quilljs.com/docs/delta/
        let expectedDoc = {
          ops: [
            { insert: 'Gandalf', attributes: { bold: true } },
            { insert: ' the ' },
            { insert: 'Grey', attributes: { color: '#cccccc' } }
          ]
        }        

        assert.deepEqual(deltaDoc, expectedDoc)
        
      })

      it('should handle concurrent overlapping spans', () => {
        let s1 = Automerge.change(Automerge.init(), doc => {
          doc.text = new Automerge.Text('Gandalf the Grey')
        })

        let s2 = Automerge.merge(Automerge.init(), s1)

        let s3 = Automerge.change(s1, doc => {
          doc.text.insertAt(8,  { bold: true })
          doc.text.insertAt(16+1, { bold: null })
        })

        let s4 = Automerge.change(s2, doc => {
          doc.text.insertAt(0,  { bold: true })
          doc.text.insertAt(11+1, { bold: null })
        })

        let merged = Automerge.merge(s3, s4)

        let deltaDoc = AutomergeTextToDeltaDoc(merged.text)

        // From https://quilljs.com/docs/delta/
        let expectedDoc = {
          ops: [
            { insert: 'Gandalf the Grey', attributes: { bold: true } },
          ]
        }

        assert.deepEqual(deltaDoc, expectedDoc)
      })

      it('should apply an insert', () => {
        let s1 = Automerge.change(Automerge.init(), doc => {
          doc.text = new Automerge.Text('Hello world')
        })

        const delta = { ops: [
          { retain: 6 },
          { insert: 'reader' },
          { delete: 5 }
        ]}

        let s2 = Automerge.change(s1, doc => {
          ApplyDeltaToAutomergeText(delta, doc)
        })
        
        assert.strictEqual(s2.text.join(''), 'Hello reader')
      })
      
      it('should apply an insert with control characters', () => {
        let s1 = Automerge.change(Automerge.init(), doc => {
          doc.text = new Automerge.Text('Hello world')
        })

        const delta = { ops: [
          { retain: 6 },
          { insert: 'reader', attributes: { bold: true } },
          { delete: 5 },
          { insert: '!' }
        ]}

        let s2 = Automerge.change(s1, doc => {
          ApplyDeltaToAutomergeText(delta, doc)
        })
        
        assert.strictEqual(s2.text.toString(), 'Hello reader!')
        assert.deepEqual(s2.text.toSpans(), [
          "Hello ",
          { bold: true },
          "reader",
          { bold: null },
          "!"
        ])
      })
    })
  })
})

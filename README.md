Can TypeSafe Jev Choice generate text through successive typed decisions? Well I tried it

https://github.com/user-attachments/assets/7a990b87-7bfd-4e2b-a030-61e5fbd2c260

## Setup

Node.js 22+ and a TypeSafe API key.

```sh
git clone https://github.com/kesku/jev-freeform.git
cd jev-freeform
npm install
export TYPESAFE_API_KEY="your-key"
npm start
```

Open http://127.0.0.1:4177.

---

## How does this work?

Jev can't generate text. It takes some state + a set of choices and returns a typed decision with probabilities over those choices.

So I gave it characters.

There are 95 printable ASCII characters, newline, tab, and EOS. 98 choices total.

For a prompt like:

```text
who are you?
```

and a reply currently at:

```text
I a
```

I ask Jev to judge continuations like:

```text
"I aA"
"I aB"
"I aC"
...
"I am"
...
"I a "
"I a\n"
EOS
```

Each option is the entire reply prefix with exactly one character appended.

The basic loop looks like this:

```text
                        ┌──────────────────┐
                        │   user prompt    │
                        │  "who are you?"  │
                        └────────┬─────────┘
                                 │
                                 v
                        ┌──────────────────┐
                        │ current prefix   │
                        │      "I a"       │
                        └────────┬─────────┘
                                 │
                                 v
                 ┌────────────────────────────┐
                 │ make every next character  │
                 │                            │
                 │ "I aA"  "I aB" ... "I am"  │
                 │             + EOS          │
                 └──────────────┬─────────────┘
                                │
                                v
                        ┌──────────────────┐
                        │    Jev Choice    │
                        │                  │
                        │ probabilities    │
                        │ over each branch │
                        └────────┬─────────┘
                                 │
                                 v
                     ┌──────────────────────┐
                     │ keep a few branches │
                     │                      │
                     │ "I am"               │
                     │ "I an"               │
                     │ "I ai"               │
                     └──────────┬───────────┘
                                │
                                v
                        ┌──────────────────┐
                        │    Jev Choice    │
                        │                  │
                        │ which prefix can │
                        │ become the best  │
                        │ answer?          │
                        └────────┬─────────┘
                                 │
                                 v
                           update prefix
                                 │
                                 └──── repeat
```

There's a dumb greedy mode that just follows the selected character.

It gets stuck pretty easily.

The default mode instead keeps several high-probability continuations from Jev's distribution and treats generation as a little search problem. Jev gets another Choice call comparing the surviving partial replies. If the current path goes bad, the controller can reject it and backtrack into an older branch.

So something like:

```text
"I m"
```

can eventually lose to an earlier:

```text
"I a"
```

branch and continue into:

```text
"I am"
```

EOS gets checked too. Instead of blindly stopping, Jev gets one final typed decision:

```text
complete
incomplete
invalid
```

Only `complete` is treated as a finished reply.

There is no tokenizer, dictionary, canned response, or other text-generating model hiding behind this. The controller only creates character choices, keeps branches, and decides what question to ask Jev next.

Jev still never returns freeform text.

The freeform text comes from composing a stupid number of typed decisions together :)

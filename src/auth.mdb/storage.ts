import type {
  NodeSavedSession,
  NodeSavedSessionStore,
  NodeSavedState,
  NodeSavedStateStore,
} from '@atproto/oauth-client-node'
import { MongoClient } from 'mongodb'

export class StateStore implements NodeSavedStateStore {
  private db
  private collection

  constructor(private dbm: MongoClient) {
    this.db = this.dbm.db('statusphere')
    this.collection = this.db.collection('auth_state')
  }
  async get(key: string): Promise<NodeSavedState | undefined> {
    const result = await this.collection.findOne({ key })
    console.log('get-result:', result)
    if (!result) return
    return JSON.parse(result.state) as NodeSavedState
  }
  
  async set(key: string, val: NodeSavedState) {
    const state = JSON.stringify(val)
    const result = await this.collection.insertOne({key: key, state: state})
    console.log('set-result:', result)
  }
  
  async del(key: string) {
    console.log('del-key:', key)
    const result = await this.collection.deleteOne({ key: key})
    console.log('del-result:', result)
  }
}

export class SessionStore implements NodeSavedSessionStore {
  private db
  private collection

  constructor(private dbm: MongoClient) {
    this.db = this.dbm.db('statusphere')
    this.collection = this.db.collection('auth_session')
  }
  
  async get(key: string): Promise<NodeSavedSession | undefined> {
    const result = await this.collection.findOne({ key })
    if (!result) return
    return JSON.parse(result.session) as NodeSavedSession
  }

  async set(key: string, val: NodeSavedSession) {
    const session = JSON.stringify(val)
    await this.collection.insertOne({key: key, session: session})
  }

  async del(key: string) {
    await this.collection.deleteOne({ key: key})
  }
}

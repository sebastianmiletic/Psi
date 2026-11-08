// Coalesce rapid edits into one current snapshot, rather than a typing history.
export class DraftAutosave {
  constructor({onError=()=>{}}={}){this.onError=onError;this.pending=null;this.running=null;this.error=null;}
  schedule(session,text){this.pending={session,text};this.start();}
  start(){
    if(this.running||!this.pending)return;
    this.running=Promise.resolve().then(async()=>{
      while(this.pending){const {session,text}=this.pending;this.pending=null;await session.saveDraft(text);this.error=null;}
    }).catch(error=>{this.error=error;this.onError(error);}).finally(()=>{this.running=null;if(this.pending)this.start();});
  }
  async flush(){while(this.running)await this.running;if(this.error)throw this.error;}
}

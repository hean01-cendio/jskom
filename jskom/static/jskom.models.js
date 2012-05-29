// Copyright (C) 2012 Oskar Skoog. Released under GPL.

"use strict";

jskom.Models.Session = Backbone.Model.extend({
    url: function() {
        var base = '/sessions/';
        if (this.isNew()) return base;
        return base + encodeURIComponent(this.id);;
    },
    
    defaults: {
        pers_name: null,
        password: null, // TODO: Somehow not store password in model
        pers_no: null,
        client: {
            name: "jskom",
            version: jskom.version
        }
    },
    
    validate: function(attrs) {
        if (!attrs.pers_name) {
            // ugly hack to make them look the same as jqXHR...
            return { responseText: "can't have an empty person name" };
        }
    },
},
{
    // Class methods here
    
    _getSessionIdFromCookie: function() {
        var session_id = $.cookie('session_id')
        console.log("getSessionIdFromCookie: " + session_id)
        return session_id;
    },
    
    fetchCurrentSession: function(callback) {
        var currentSessionId = jskom.Models.Session._getSessionIdFromCookie();
        if (!currentSessionId || currentSessionId == '') {
            console.log("currentSessionId: " + currentSessionId);
            callback(new jskom.Models.Session());
        } else {
            var currentSession = new jskom.Models.Session({
                id: currentSessionId
            });
            currentSession.fetch({
                success: function(session, resp) {
                    console.log("currentSession.fetch - success");
                    callback(session);
                },
                error: function(session, resp) {
                    console.log("currentSession.fetch - error");
                    callback(new jskom.Models.Session());
                }
            });
        }
    }
});

jskom.Models.Recipient = Backbone.Model.extend({
    defaults: {
        type: null,
        conf_name: null,
        conf_no: null
    }
});

jskom.Collections.RecipientList = Backbone.Collection.extend({
    model: jskom.Models.Recipient
});

jskom.Models.Text = Backbone.Model.extend({
    idAttribute: 'text_no',
    
    url: function() {
        var base = '/texts/';
        if (this.isNew()) return base;
        return base + this.get('text_no');
    },
    
    defaults: {
        text_no: null,
        creation_time: null,
        author: null,
        comment_to_list: null,
        comment_in_list: null,
        content_type: null,
        subject: '',
        body: ''
    },
    
    initialize: function(options) {
        this._fetchDeferred = null; // created when deferredFetch is called the first time.
        this.set({ recipient_list: new jskom.Collections.RecipientList() });
    },
    
    getSafeBody: function() {
        var safeBody = Handlebars.Utils.escapeExpression(this.get('body'));
        safeBody = safeBody.replace(/\r?\n|\r/g, "<br>");
        return new Handlebars.SafeString(safeBody);
    },
    
    toJSON: function() {
        var json = _.clone(this.attributes);
        if (this.get('recipient_list')) {
            json.recipient_list = this.get('recipient_list').map(function(recipient) {
                return recipient.toJSON();
            });
        } else {
            json.recipient_list = null;
        }
        return json;
    },
    
    parse: function(resp, xhr) {
        var recipientListJson = resp.recipient_list;
        var recipients = _.map(recipientListJson, function(recipientJson) {
            var r = new jskom.Models.Recipient();
            r.set(r.parse(recipientJson), { silent: true });
            return r;
        });
        // overwrite the json with the parsed collection
        resp.recipient_list = new jskom.Collections.RecipientList(recipients);
        return resp;
    },

    deferredFetch: function() {
        if (!this._fetchDeferred) {
            var self = this;
            this._fetchDeferred = this.fetch().done(
                function(data) {
                    console.log("text.deferredFetch(" + self.get('text_no') + ") - success");
                }
            ).fail(
                function(jqXHR, textStatus) {
                    console.log("text.deferredFetch(" + self.get('text_no') + ") - error");
                }
            );
        }
        return this._fetchDeferred;
    },
    
    markAsReadGlobal: function() {
        return new jskom.Models.GlobalReadMarking({ text_no: this.get('text_no') }).save();
    },
    
    markAsUnreadGlobal: function() {
        return new jskom.Models.GlobalReadMarking({ text_no: this.get('text_no') }).destroy();
    },
    
    makeCommentTo: function(otherText) {
        otherText.get('recipient_list').each(function(r) {
            // Only copy "to" recipients, not "cc" or "bcc".
            if (r.get('type') == 'to') {
                this.get('recipient_list').add(r.clone());
            }
        }, this);
        this.set({
            comment_to_list: [
                { type: 'comment', text_no: otherText.get('text_no') }
            ],
            subject: otherText.get('subject')
        });
    }
});

// ReadQueue is not a collection, because you cannot use it as a collection.
jskom.Models.ReadQueue = Backbone.Model.extend({
    initialize: function(options) {
        options || (options = {})
        // TODO: prefetch handling
        
        // Should be treated as a set of text numbers.
        if (options.unreadTextNos) {
            this._unreadTextNos = _.uniq(options.unreadTextNos);
        } else {
            this._unreadTextNos = [];
        }
        
        this._currentText = null;
        this._currentThreadStack = [];
    },
    
    addUnreadTextNos: function(text_nos) {
        this._unreadTextNos = _.union(this.unreadTexts, text_nos);
        this.trigger('add', this);
    },
    
    removeUnreadTextNo: function(text_no) {
        this._unreadTextNos = _.without(this._unreadTextNos, text_no);
        this.trigger('remove', this);
    },
    
    first: function() {
        if (this._currentText == null && this.size() > 0) {
            this.moveNext();
        }
        
        return this._currentText;
    },
    
    // TODO: Can we make this a deferred that can be called multiple times until
    // we've fetched the new text? And after we've fetched the new text,
    // calling it should create a new deferred.
    moveNext: function() {
        // Algorithm:
        // 
        // We use a stack to store the parts of the thread we don't
        // visit this time. Because we are not traversing the entire
        // tree at this time, we need to remember texts (branches)
        // further up in the tree, so we know where to continue when
        // the current branch ends.
        // 
        // If there are texts on the stack: pop to get the new text.
        // 
        // Else: find new thread start by selecting the unread text
        // with lowest text number.
        // 
        // For the new text, push all unread comments onto the stack, in
        // reverse order.
        
        var nextTextNo = null;
        if (this._currentThreadStack.length > 0) {
            // We still have texts to read in this thread
            nextTextNo = this._currentThreadStack.pop();
            console.log("readQueue:moveNext() - pop:ed " + nextTextNo + " from stack.")
        } else {
            // No more texts in this thread, find new thread
            
            if (this._unreadTextNos.length > 0) {
                // We have unread texts, find new thread start
                nextTextNo = _.min(this._unreadTextNos);
                console.log("readQueue:moveNext() - found new thread in " + nextTextNo);
            } else {
                // No unread texts
                nextTextNo = null;
                console.log("readQueue:moveNext() - no unread texts.")
            }
        }
        
        if (nextTextNo != null) {
            this.removeUnreadTextNo(nextTextNo);
            var newText = new jskom.Models.Text({ text_no: nextTextNo });
            
            // TODO: Check that we don't call moveNext() without waiting for the
            // current text to be fetched.
            
            // TODO: Push Text models onto the thread stack, instead
            // of text numbers.  That way it would at least be quite
            // easy to implement prefetching of texts in the current
            // thread.
            
            // Start fetching the new current text, and when we have
            // fetched the text: Push all comments onto the stack, in
            // reverse order
            var self = this;
            newText.deferredFetch().done(function() {
                var comments = _.clone(newText.get('comment_in_list'));
                if (comments) {
                    var commentTextNos = _.pluck(comments, 'text_no');
                    commentTextNos.reverse();
                        _.each(commentTextNos, function(commentTextNo) {
                            self._currentThreadStack.push(commentTextNo);
                        });
                }
                
                // Don't trigger the change event until we've fetched the text
                // That way we know that we won't call moveNext() again until
                // the new text has been fetched.
                self._currentText = newText;
                self.trigger('change', self);
            });
        } else {
            // Nothing to read, set currentText to null
            this._currentText = null;
            this.trigger('change', this);
        }
    },
    
    isEmpty: function() {
        return !(this.size > 0);
    },
    
    size: function() {
        // should we include currentText or not?
        return this._unreadTextNos.length; // does not include currentText
    }
});

jskom.Models.UnreadConference = Backbone.Model.extend({
    idAttribute: 'conf_no',
    
    defaults: {
        conf_no: null,
        name: null,
        no_of_unread: null
    }
});

jskom.Collections.UnreadConferences = Backbone.Collection.extend({
    model: jskom.Models.UnreadConference,
    
    url: '/conferences/unread/',
    
    // Because httpkom doesn't return an array of models by default we need
    // to point Backbone.js at the correct property
    parse: function(resp, xhr) {
        return resp.confs;
    },
});


jskom.Models.LocalReadMarking = Backbone.Model.extend({
    idAttribute: 'text_no',
    
    defaults: {
        conf_no: null,
        local_text_no: null,
        text_no: null,
        unread: null,
    },
    
    url: function() {
        return '/conferences/' + encodeURIComponent(this.get('conf_no')) +
            '/texts/' + encodeURIComponent(this.get('local_text_no')) + '/read-marking';
    },
});

jskom.Models.GlobalReadMarking = Backbone.Model.extend({
    idAttribute: 'text_no',
    
    defaults: {
        text_no: null,
        unread: null,
    },
    
    url: function() {
        return '/texts/' +
            encodeURIComponent(this.get('text_no')) + '/read-marking';
    },
});

jskom.Collections.ReadMarkings = Backbone.Collection.extend({
    model: jskom.Models.LocalReadMarking,
    
    url: function() {
        return '/conferences/' +
            encodeURIComponent(this.conf_no) + '/read-markings/';
    },
    
    initialize: function(models, options) {
        this.conf_no = options.conf_no;
    },

    // Because httpkom doesn't return an array of models by default we need
    // to point Backbone.js at the correct property
    parse: function(resp, xhr) {
        return resp.rms;
    },
});
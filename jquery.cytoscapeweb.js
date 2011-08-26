;(function($){

	// registered modules to cytoweb, indexed by name
	var reg = {
		format: {},
		renderer: {},
		layout: {}
	};

	var quiet = false;
	var console = {
		log: function(){
			if( quiet ){ return; }
			
			if( window.console != null && window.console.log != null ){
				window.console.log.apply(window.console, arguments);
			}
		},
		
		warn: function(){
			if( quiet ){ return; }
			
			if( window.console != null && window.console.warn != null ){
				window.console.warn.apply(window.console, arguments);
			} else {
				console.log(arguments);
			}
		},
		
		error: function(){
			if( quiet ){ return; }
			
			if( window.console != null && window.console.error != null ){
				window.console.error.apply(window.console, arguments);
			} else {
				console.log(arguments);
				throw "Cytoscape Web encountered the previously logged error";
			}
		}
	};
	
	// allow calls on a jQuery selector by proxing calls to $.cytoscapeweb
	// e.g. $("#foo").cytoscapeweb(options) => $.cytoscapeweb(options) on #foo
	$.fn.cytoscapeweb = function(opts){

		// proxy to create instance
		if( $.isPlainObject(opts) ){
			return $(this).each(function(){
				var options = $.extend({}, opts, {
					selector: $(this)
				});
			
				$.cytoscapeweb(options);
			});
		}
		
		// proxy a function call
		else {
			var rets = [];
			
			$(this).each(function(){
				var cy = $(this).data("cytoscapeweb");
				var fnName = opts;
				var args = Array.prototype.slice.call( arguments, 1 );
				
				if( cy != null && $.isFunction( cy[fnName] ) ){
					var ret = cy[fnName].apply(cy, args);
					rets.push(ret);
				}
			});
			
			// if only one instance, don't need to return array
			if( rets.length == 1 ){
				rets = rets[0];
			}
			
			return rets;
		}

	};

	// allow functional access to cytoweb
	// e.g. var cytoweb = $.cytoscapeweb({ selector: "#foo", ... });
	//      var nodes = cytoweb.nodes();
	$.cytoscapeweb = function(opts){
		
		// create instance
		if( $.isPlainObject(opts) ){
			var defaults = {
				layout: {
					name: "forcedirected"
				},
				renderer: {
					name: "svg"
				},
				style: { // actual default style later specified by renderer
					global: {},
					nodes: {},
					edges: {}
				}
			};
			
			var options = $.extend(true, {}, defaults, opts);
			
			// structs to hold internal cytoweb model
			var structs = {
				style: options.style,
				nodes: {}, // id => node object
				edges: {}  // id => edge object
			};
			
			// return a deep copy of an object
			function copy(obj){
				if( $.isArray(obj) ){
					return $.extend(true, [], obj);
				} else {
					return $.extend(true, {}, obj);
				}
			}
			
			var idFactory = {
				prefix: {
					nodes: "n",
					edges: "e"
				},
				id: {
					nodes: 0,
					edges: 0
				},
				generate: function(group, tryThisId){
					var id = tryThisId != null ? tryThisId : this.prefix[group] + this.id[group];
					
					while( structs[group][id] != null ){
						id = this.prefix[group] + ( ++this.id[group] );
					}
					
					return id;
				}
			};
			
			
			// CyElement
			////////////////////////////////////////////////////////////////////////////////////////////////////
			
			// represents a node or an edge
			var CyElement = function(params){
			
				if( params.group != "nodes" && params.group != "edges" ){
					console.error("An element must be of type `nodes` or `edges`; you specified `" + params.group + "`");
					return;
				}
				
				this._private = {
					data: copy( params.data ), // data object
					position: copy( params.position ), // fields x, y, etc (could be 3d or radial coords; renderer decides)
					listeners: {}, // map ( type => array of functions )
					group: params.group, // string; "nodes" or "edges"
					bypass: copy( params.bypass ),
					removed: false, // whether it's inside the vis; true if removed
					selected: false // whether it's selected
				};
				
				if( this._private.data.id == null ){
					this._private.data.id = idFactory.generate( this._private.group );
				} else if( structs[ this._private.group ][ this._private.data.id ] != null ){
					console.error("Can not create element: an element in the visualisation in group `" + this._private.group + "` already has ID `" + this._private.data.id);
					return;
				}
				  
				structs[ this._private.group ][ this._private.data.id ] = this;
				
				notifyRenderer({
					type: "add",
					elements: [ this ]
				});
			};
				
			CyElement.prototype.group = function(){
				return this._private.group;
			}
			
			CyElement.prototype.removed = function(){
				return this._private.removed;
			};
			
			CyElement.prototype.selected = function(){
				return this._private.selected;
			};
			
			// remove from cytoweb
			CyElement.prototype.remove = function(){
				if( !this._private.removed ){
					delete structs[ this._private.group ][ this._private.data.id ];
					this._private.removed = true;
					
					notifyRenderer({
						type: "remove",
						elements: [ this ]
					});
				}
				
				return this;
			};

			// proxy to the bypass object				
			CyElement.prototype.bypass = function(newBypass){	
				if( newBypass === undefined ){
					return copy( structs.bypass[ this._private.group ][ this._private.data.id ] );
				} else {
					structs.bypass[ this._private.group ][ this._private.data.id ] = copy( newBypass );
				}
			};
			
			function attrGetterSetter(params){
				return function(attr, val){
					var ret;
					
					if( val === undefined ){
						ret = this._private[ params.name ][ attr ];
						ret =  ( typeof ret == "object" ? copy(ret) : ret );
					} else {
						 this._private[ params.name ][ attr ] = ( typeof val == "object" ? copy(val) : val );
						ret = this;
						
						if( !this._private.removed ){
							notifyRenderer({
								type: params.name,
								collection: [ this ]
							});
						}
					}		
					
					return ret;
				};
			}
			
			CyElement.prototype.data = attrGetterSetter({ name: "data" });
			
			CyElement.prototype.position = function(val){
				if( val === undefined ){
					return copy( this._private.position );
				} else {
					this._private.position = copy( val );
				}
				
				if( !this._private.removed ){
					notifyRenderer({
						type: "position",
						collection: [ this ]
					});
				}
			};
			
			CyElement.prototype.style = function(){
				// ask renderer for computed style
				return copy( renderer.style(this) );
			};
			
			CyElement.prototype.bind = function(event, callback){
				if( this._private.listeners[event] == null ){
					this._private.listeners[event] = [];
				}				
				this._private.listeners[event].push(callback);
				
				return this;
			};
			
			CyElement.prototype.unbind = function(event, callback){
				var listeners = this._private.listeners[event];
				
				if( listeners != null ){
					$.each(listeners, function(i, listener){
						if( callback == null || callback == listener ){
							listeners[i] = undefined;
						}
					});
				}
				
				return this;
			};
			
			CyElement.prototype.trigger = function(event, data){
				var listeners = this._private.listeners[event];
				
				var eventData = data; 
				if( listeners != null ){
					$.each(listeners, function(i, listener){
						if( $.isFunction(listener) ){
							listener(eventData);
						}
					});
				}
				
				return this;
			};
			
			CyElement.prototype.select = function(){
				this._private.selected = true;
				
				notifyRenderer({
					type: "select",
					elements: [ this ]
				});
				
				this.trigger("select");
			};
			
			CyElement.prototype.unselect = function(){
				this._private.selected = false;
				
				notifyRenderer({
					type: "unselect",
					elements: [ this ]
				});
				
				this.trigger("unselect");
			};
			
			CyElement.prototype.firstNeighbors = function(){
				// TODO
				// note must check group()
			};
		
			function listenerAlias(params){
				return function(callback){
					return this.bind(params.name, callback);
				};
			}
			
			// aliases to listeners, e.g. node.click(fn) => node.bind("click", fn)
			// TODO add more
			CyElement.prototype.mousedown = listenerAlias("mousedown");
			CyElement.prototype.mouseup = listenerAlias("mouseup");
			CyElement.prototype.mousemove = listenerAlias("mousemove");
			CyElement.prototype.click = listenerAlias("click");
			
			
			// CyCollection
			////////////////////////////////////////////////////////////////////////////////////////////////////
			
			// represents a set of nodes, edges, or both together
			function CyCollection(elements){
				for(var i = 0; i < elements.length; i++){
					this[i] = elements[i];
				}
				
				this.length = elements.length;
				this.size = function(){
					return this.length;
				}
			}

			CyCollection.prototype.toArray = function(){
				var array = [];
				
				for(var i = 0; i < this.size(); i++){
					array.push( this.eq(i) );
				}
				
				return array;
			};
			
			CyCollection.prototype.eq = function(i){
				return this[i];
			};
			
			CyCollection.prototype.each = function(fn){
				for(var i = 0; i < this.size(); i++){
					fn.apply( this.eq(i), [ i, this.eq(i) ] );
				}
				return this;
			};
			
			CyCollection.prototype.add = function(toAdd){
				var elements = [];
			
				// add own
				this.each(function(i, element){
					elements.push(element);
				});
			
				// add toAdd
				if( $isFunction(toAdd.size) ){
					// we have a collection
					var collection = toAdd;
					collection.each(function(i, element){
						elements.push(element);
					});
				} else {
					// we have one element
					var element = toAdd;
					elements.push(element);
				}
				
				return new CyCollection(elements);
			};
			
			CyCollection.prototype.filter = function(filterFn){
				var elements = [];
				this.each(function(i, element){
					if( !$.isFunction(filterFn) || filterFn.apply(element, [i, element]) ){
						elements.push(element);
					}
				});

				return new CyCollection(elements);
			};
			
			
			CyCollection.prototype.positions = function(fn){
				
				var collection = this;
				
				noNotifications(function(){
					collection.each(function(i, element){
						var positionOpts = fn.apply(element, [i, element]);
						element.position(positionOpts);
					});
				});

				notifyRenderer({
					type: "position",
					collection: this
				});
			};
			
			// what functions in CyElement update the renderer
			var rendererFunctions = [ "data", "select", "unselect", "position", "restore" ];
			
			// functions in element can also be used on collections
			$.each(CyElement.prototype, function(name, func){
				CyCollection.prototype[name] = function(){
					var rets = [];
					var collection = false;
				
					// disable renderer notifications during loop
					// just notify at the end of the loop with the whole collection
					var notifyRenderer = $.inArray(name, rendererFunctions) >= 0;
					if( notifyRenderer ){
						rendererNotificationsEnabled(false);
					}
				
					for(var i = 0; i < this.size(); i++){
						var element = this[i];
						var ret = func.apply(element, arguments);
						
						if( ret !== undefined ){
							rets.push(ret);
						}
						
						if( ret == element ){
							collection = true;
						}
					}
					
					// notify the renderer of the call on the whole collection
					// (more efficient than sending each in a row---may have flicker?)
					if( notifyRenderer ){
						rendererNotificationsEnabled(true);
						notifyRenderer({
							type: name,
							collection: this
						});
					}
					
					if( collection ) {
						var elements = rets;
						rets = new CyCollection(elements);
					}
					
					if( rets.length == 0 ){
						rets = this; // if function doesn't return a value, return this for chaining
					} 
					
					return rets;
				};
			});
			
			// Cytoscape Web object and helper functions
			////////////////////////////////////////////////////////////////////////////////////////////////////

			var layout = new reg.layout[ options.layout.name.toLowerCase() ]( options.layout );
			
			var renderer = new reg.renderer[ options.renderer.name.toLowerCase() ]( options.renderer );
			var rendererNotifications = true;
			
			function noNotifications(fn){
				rendererNotificationsEnabled(false);
				fn();
				rendererNotificationsEnabled(true);
			}
			
			function rendererNotificationsEnabled(enabled){
				rendererNotifications = enabled;
			}
			
			function notifyRenderer(params){
				rendererNotifications && renderer.notify(params);
			}
			
			function jsonGetterSetter(params){
				return function(val){
					var ret;
					
					if( val === undefined ){
						ret = copy( structs[params.struct] );
					} else {
						structs[params.struct] = copy( val );
						ret = this;
					}
					
					$.isFunction(params.after) && params.after();
					return ret;
				};
			}
			
			// getting nodes/edges with a filter function to select which ones to include
			function elementsCollection(params){
				return function(filterFn){
					var elements = [];
					
					function filter(element){
						if( !$.isFunction(filterFn) || filterFn.apply(element, [element]) ){
							elements.push(element);
						}
					}
					
					if( params != null && params.group != null ){
						$.each(structs[params.group], function(id, element){
							filter(element);
						});
					} else {
						$.each(structs["nodes"], function(id, element){
							filter(element);
						});
						$.each(structs["edges"], function(id, element){
							filter(element);
						});
					}
					
					var collection = new CyCollection(elements);
					return collection;
				};
			}
			
			// add node/edge to cytoweb
			function addElement(params){
				return function(opts){
				
					var elements = [];
					
					noNotifications(function(){
						
						// add the element
						if( opts instanceof CyElement ){
							var element = opts;
							
							elements.push( new CyElement({
								group: element._private.group,
								data: element._private.data,
								bypass: element._private.bypass
							}) );
						} 
						
						// add the collection
						else if( opts instanceof CyCollection ){
							var collection = opts;
							collection.each(function(i, element){
								
								elements.push( new CyElement({
									group: element._private.group,
									data: element._private.data,
									bypass: element._private.bypass
								}) );
								
							});
						} 
						
						// specify an array of options
						else if( $.isArray(opts) ){
							$.each(opts, function(i, elementParams){
								var element = new CyElement(elementParams);
								elements.push(element);
							});
							
						} 
						
						// specify options for one element
						else {
							elements.push( new CyElement({
								group: params.group,
								data: opts.data,
								bypass: opts.bypass
							}) );
						}
					});
					
					notifyRenderer({
						type: "add",
						collection: elements
					});
				}
			}
			
			// this is the cytoweb object
			var cy = {
				
				style: jsonGetterSetter({ struct: "style", after: function(){
					notifyRenderer({
						style: structs.style
					});
				} }),
				
				bypass: jsonGetterSetter({ struct: "bypass", after: function(){
					notifyRenderer({
						bypass: structs.bypass
					});
				} }),
				
				add: addElement(),
				
				remove: function(collection){
					collection.remove();
				},
				
				addNode: addElement({ group: "nodes" }),
				
				addEdge: addElement({ group: "edges" }),
				
				node: function(id){
					return structs.nodes[id];
				},
				
				edge: function(id){
					return structs.edges[id];
				},
				
				nodes: elementsCollection({ group: "nodes" }),
				
				edges: elementsCollection({ group: "edges" }),
				
				elements: elementsCollection(),
				
				layout: function(params){
				
					if( params == null ){
						params = options.layout;
					}
					
					var name = params.name != null ? params.name : options.layout.name;
				
					// TODO don't create new instance if same type
					layout = new reg.layout[name](params);
					
					layout.run( $.extend({}, params, {
						nodes: cy.nodes(),
						edges: cy.edges(),
						renderer: renderer
					}) );
				},
				
				pan: function(params){
					renderer.pan(params);
				},
				
				load: function(data){
					// TODO delete old elements?
				
					if( data != null ){
						
						noNotifications(function(){
							$.each(options.data, function(group, elements){
								$.each(elements, function(i, params){
									// add element
									var element = new CyElement( {
										group: group,
										data: params
									} );
								});
							});
						});
						
					}
					
					notifyRenderer({
						type: "add", // TODO should this be a different type?
						collection: cy.elements(),
						style: structs.style,
						bypass: structs.bypass
					});
				}
				
			};
			
			cy.load(options.data);
			cy.layout();
			return cy;
		} 
		
		// logging functions
		else if( typeof opts == typeof "" && $.isFunction(console[opts]) ){
			var args = [];
			for(var i = 1; i < arguments.length; i++){
				args.push( arguments[i] );
			}
			
			console[opts].apply(console, args);
		}
		
		else if( opts == "quiet" ){
			quiet = ( arguments[1] != null && arguments[1] != false );
		}
		
		// allow for registration of extensions
		// e.g. $.cytoscapeweb("renderer", "svg", { ... });
		else if( typeof opts == typeof "" ) {
			var registrant = arguments[0].toLowerCase(); // what to register (e.g. "renderer")
			var name = arguments[1].toLowerCase(); // name of the module (e.g. "svg")
			var module = arguments[2]; // the module object
			
			if( module == null ){
				// get the module by name; e.g. $.cytoscapeweb("renderer", "svg");
				return reg[registrant][name];
			} else {
				// set the module; e.g. $.cytoscapeweb("renderer", "svg", { ... });
				reg[registrant][name] = module;
			}
		}
	};
	
	// use short alias (cy) if not already defined
	if( $.fn.cy == null && $.cy == null ){
		$.fn.cy = $.fn.cytoscapeweb;
		$.cy = $.cytoscapeweb;
	}
	
})(jQuery);

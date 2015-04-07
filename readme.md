Hyperstore Documentation

#About#
{: #about}

Hyperyun is a Backend-as-a-Service that features 'reactive' data queries: your application is notified whenever data you have asked about has changed so that you can update content immediately for your user. This documentation consists of the API specification as well as some tips and information for using Hyperstore quickly.

#Quickstart#
{: #quickstart}

For each Hyperyun application your webpage needs to interact with, you must initialize a hyperstore connection:

	Hyperstore.initialize('myAppName',['collectionA','collectionB','collectionC'])

This lets us access collectionA, collectionB, and collectionC in the 'myAppName' application's database by making calls to Hyperstore.myAppName. For convenience, the first application that is initialized is aliased to Hyperstore: this means (for the first app initialized) you can make calls like Hyperstore.find(...) and such when you would generally use Hyperstore.myAppName.find(...).

Once we're connected, we can perform whatever tasks we need to perform firstmost typically being a find of some kind:

	var currentPizzas = []
	var doNeatStuffWithHyperyun = function()
	{
		//Look for all available cheese pizza types
		Hyperstore.myAppName.find({pizzaType: "cheese"}, function(res,err,ver){
			if(!err)
			{
				currentPizzas = res;
				console.log("There were " + res.length + " cheese pizzas available at " + ver);
			}
		})
	}

We can also make changes to the database, such as inserting a new variety of pizza:

	Hyperstore.myAppName.insert({pizzaType: "cheese", name: "The Medusa", toppings: ["gorgonzola", "feta"], base: "balsamic"});

By default whenever a new kind of pizza is added to the collection, our client will run any relevant find's callback parameter again: so, if our new 'gorngonzola' pizza is added, our original find will update `self.currentPizzas` to include the new pizza. You can disable this feature for any single find by setting `reactive: false` in the options for the find:

	//Look for all available cheese pizza types, but ignore future updates
	Hyperstore.myAppName.find({pizzaType: "cheese"}, {reactive: false}, function(res,err,ver){
			// etc...
	});

More specific information about other Hyperstore usage can be found in the 'How to Use' section and the Hyperstore API


#How to Use#
{: #howtouse}

Before using hyperyun.js on your client, you will have to register at [Hyperyun](http://hyperyun.com) and create a new application. After setting up your application at the Hyperstore Administration Panel, the server will be ready to interact with your client code.

Hyperstore provides a means by which to centrally store data concerning many users on the Hyperyun servers for easy retrieval and sharing across your userbase. Whenever a user of your client affects a change on the server, all other peers see the change without having to 'poll' the server: this behaviour is very useful in creating live web applications. Further, this is accomplished with a minimal of fuss in terms of code by using a consistent function callback strategy.

Hyperyun is built atop Mongo: each Hyperyun application is associated with its own set of Mongo collections, where all your 'documents' are stored. Hyperstore uses [MongoDB syntax](http://docs.mongodb.org/manual/core/crud/) for data access queries, which is centered around sending JSON objects whose fields specify some constraint or new value for the documents to affect in the database. Familiarizing yourself with how to structure your application's data will be useful for ensuring you can get the most out of Hyperyun: consider researching NoSQL practices and perusing [Mongo's documentation](http://docs.mongodb.org/manual/data-modeling/).

The most common methods you will therefore use are likely to be the Data Access methods such as Find, Insert, Update, and Remove which will let you interact with your database. You can find the specification and examples of these methods in the API.

#Hyperyun Security

//TODO: Make this better
There are two 'special' collections in each Hyperyun application: 'users' and 'files'. The 'users' table only allows writes to 'profile' document fields, and 'files' only allows writes to 'userdata' document fields. You will generally interact with these tables in a Read-Only fashion, or using the user account API and upload/removeFile methods. Any other collections' security settings are wholly yours to determine.

#API#

##Hyperyun##

To get access to Hyperyun, you will need to import hyperyun.js into your web application. Hyperstore comes bundled with lodash.js, and mixes in a few methods 

###Hyperstore.initialize(appName, collections [, options])###
{: #initialize}

The Hyperstore global object manages all your application connections to Hyperyun. To create a connection to your application's database, you use the initialize function on the global object. After the initialization has completed, the Hyperstore global object will have the application available as a member object (referenced by the appName) to make API calls on.

* __appName__: The application identifier for the Hyperyun application you wish to connect to
* __collections__: An array of collections to 'tune in' to in the application. By default, 'users' is connected to
* __options__: Optional object that lets you target a different data server
	* server - domain to connect to instead of 'hyperyun.com'
	* fullserverurl - subdomain to connect to instead of '<myApp>.hyperyun.com'

Example:

	//Connect to the 'fooCollection' and 'barCollection' of an app named 'foo'
	Hyperstore.initialize('foo',['fooCollection','barCollection'])
	//Log in using the newly available 'foo' object in Hyperstore
	Hyperstore.apps.foo.login(...)
	//Run a command on 'fooCollection'
	Hyperstore.apps.foo.fooCollection.find(...)
	//Use the Hyperstore alias for the first-initialized app
	Hyperstore.fooCollection.find(...) //Same as Hyperstore.foo.fooCollection.find(...) in this case


---

##Data Access##

Hyperyun is powered by MongoDB, a NoSQL implementation. As such, it uses Mongo query syntax for the various data access methods here: you can find full documentation about how to construct such JSON objects at the [MongoDB Official Documentation page](http://docs.mongodb.org/manual/core/crud-introduction/). 

###find (selector, [options , callback])###
{: #find}

This method retrieves documents from Hyperyun according to your query selector, and will attempt to cache the results locally for efficient retrieval later. This method returns a UUID string that can be used in conjunction with `closeFind` to disable the find (if reactive) later in your code's execution.

* __selector__: MongoDB query object responsible for selecting relevant documents.
* __options__: object containing any of the following parameters
	* `reactive` - set to false to not trigger this query's callback whenever the find's results change. Default: TRUE
	* `projection` - MongoDB projection object for filtering document fields. `_id` is always returned, however.
	* `sort` - MongoDB sort object for ordering documents returned
	* `skip` - Number of documents to skip before including documents in the find's results
	* `limit` - Maximum number of documents for this find to return
* __callback__: Optional function callback to perform upon successful find (and whenever the find's results change, if this find is reactive). This callback is passed the following parameters in the order (res, err, ver).
	* `res` - An array of JSON objects returned by the query (or `null` if an error occurred)
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the update operation on the server

Example:

	//Find users named 'Ted'
	Hyperstore.myApp.myCollection.find({name: "Ted"},function(res, err, ver){
		if(!err)
		{
			for(var entry in res)
				console.log(JSON.stringify(entry));
		} else throw err;
	});

.

	//Show the first 20 documents in the collection
	Hyperstore.myApp.myCollection.find({},{limit:20},function(res, err, ver){
		if(!err)
		{
			for(var entry in res)
				console.log(JSON.stringify(entry));
		}
		else throw err;
	});

.

	//Display only the toppings (not other information) for each kind of 'cheese' pizza
	Hyperstore.myApp.myCollection.find({pizzaType: "cheese"},{projection:{toppings:1}}, function(res, err, ver){
		if(!err)
		{
			for(var entry in res)
				console.log(JSON.stringify(entry.toppings));
		} else throw err;
	});

.

	//Search for women's names in the database, but don't react when women are added/removed from the collection
	Hyperstore.myApp.myCollection.find({gender: "female"}, {reactive:1, projection:{name:1}}, function(res, err, ver){
		if(!err)
			femaleNameArray = res;
		} else throw err;
	});

###findOne (selector, [options , callback])###
{: #findone}

This is a convenience method for `find`, where the `limit:` options parameter is set to 1.

* __selector__: MongoDB query object responsible for selecting relevant documents
* __options__: object containing any of the following parameters
	* `reactive` - set to false to not trigger this query's callback whenever the find's results change. Default: TRUE
	* `projection` - MongoDB projection object for filtering document fields
	* `sort` - MongoDB sort object for ordering documents returned
	* `skip` - Number of documents to skip before including documents in the find's results
* __callback__: Optional function callback to perform upon completion (and whenever the find's results change, if this find is reactive). This callback is passed the following parameters in the order (res, err, ver).
	* `res` - The JSON object returned by the query (or `null` if an error occurred)
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the find operation on the server

Example:

	//Find by an ID
	var myID = //...
	Hyperstore.myApp.myCollection.findOne({_id: myID}, function(res, err, ver){
		if(!err)
		{
			console.log(res);
		} else throw err;
	})

###closeFind (find_uuid, [callback])###
{: #closeFind}

This method destroys a currently-active reactive find, referenced by its find_uuid that was generated when the find was first instantiated. `closeFind` returns false if the find was not found, or an object containing information about the find if successfully destroyed.

* __find_uuid__: UUID string of the reactive find to be disabled.
* __callback__: Optional function callback to perform after the find has been disabled. Note that this method is synchronous, so the callback will simpy run when the function has finished execution. This callback is passed false if the find was not found, or the object that was removed from the findlist if successfully destroyed.

###forceFind (find_uuid)###
{: #forceFind}

This method forces a refresh of a currently-active reactive find with the remote server, refreshing the cache.

* __find_uuid__: UUID string of the reactive find to be forced to run.

###resetReactivity ([callback])###
{: #resetReactivity}

This method makes the Hyperstore forget and discard previous reactive finds' callbacks.

* __callback__: Optional function callback that is guaranteed to execute once reactivity has been reset.
	* `res` - `true` if successful (or `false` if an error occurred)
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the clear

Example

	Hyperstore.myApp.myCollection.resetReactivity(function(res,err,ver){
		if(!err)
		{
			console.log(res);
		} else throw err;
	});

###insert (insert [, options , callback])###
{: #insert}

Use this method to add a new document to your Hyperstore collection

* __insert__: MongoDB document object to add to the collection
* __options__: object containing any of the following parameters
	* `analytics` - If present, Hyperyun Analytics will log an entry associating this object with the time Hyperstore performed this insert.
* __callback__: Optional function callback. Is passed the following three parameters (res, err, ver):
	* `res` - The inserted document (or `null` if an error occurred)
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the insertion operation on the server

Example:

	//Insert a new document, triggering an analytics event and output a confirmation
	Hyperstore.myApp.myCollection.insert({firstName: "Edward", lastName: "Miller", joinDate: new Date(), isAlive: true}, {analytics:"User Joined"}, function(res, err, ver){
		if(!err)
		{
			console.log("Successful join");
		} else console.log(err);
	})

###update (selector, modifier [, options , callback])###
{: #update}

Use this method to edit existing documents in your Hyperstore collection. Defaults to only updating the first result.

* __selector__: MongoDB query object responsible for selecting documents to modify
* __modifier__: MongoDB modifier object that specifies changes to make to selected documents. Should make use of $set, $unset, and similar to affect changes: whole-document replacement is not yet fully supported.
* __options__: object containing any of the following parameters
	* `upsert` - If no document matching the selector is found, insert a new document according to the modifier specified. Default = FALSE
	* `multi` - Change all documents that match the query, rather than simply the first. Default = FALSE
	* `writeConcern` - Specify the MongoDB 'write concern' of this update
	* `analytics` - If present, Hyperyun Analytics will log an entry associating this object with the time Hyperstore performed edit
* __callback__: Optional function callback. Is passed the following three parameters (res, err, ver):
	* `res` - Number of affected documents
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the update operation on the server

Examples:

	//Update a document, inserting a new entry if no documents matched
	Hyperstore.myApp.myCollection.update({name: "Michal"},{$set:{lastName:"Kowalkowski", company:"Hyperyun", position:"CTO"}}, {upsert: true});
	//Increment a field of a document
	Hyperstore.myApp.myCollection.update({_id: myID},{logins: {$inc:1}});

###remove (selector [, options , callback])###
{: #remove}

Use this method to remove existing documents in your Hyperyun collection. Defaults to only removing the first result.

* __selector__: MongoDB query object responsible for selecting documents to modify
* __options__: object containing any of the following parameters
	* `analytics` - If present, Hyperyun Analytics will log an entry associating this object with the time Hyperstore performed this deletion.
	* `multi` - Change all documents that match the query, rather than simply the first. Default = FALSE
* __callback__: Optional function callback. Is passed the following two parameters (err, ver):
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the removal operation on the server

Example:

	//Remove everyone who doesn't like Dance music from our collection
	Hyperstore.myApp.myCollection.remove({hatedGenre: "Dance"}, function(response){
		if(err) console.error(err)
	});

###_chmod (documentSelector, permissionToSet, [, options, callback])###
{: #_chmod}

Use this method to set the permissions on a set of documents in the database, or their subfields.

* __documentSelector__: MongoDB query object used to match those documents to be affected by the _chmod
* __permissionToSet__: Hex-value or Hex-String (0x777 or "777" style) unix-style permission to set the targets' permissions to
* __options__: object containing any of the following parameters
	* `recursiveSelector` - For the documents found by `documentSelector`, the top-level and every sub-document will be matched agains this MongoDB query object. If matched, the level will have its permissions set
	* `omitFieldToSet` - Specifies a field-level security to set. Is a string equal to the key to set permissions on
* __callback__: Optional function callback. Is passed the following parameters (res,err,ver):
	* `res` - Number of documents affected
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the update operation on the server

Example:

	//Make documents that hate dance only visible to the owner of the document
	Hyperstore.myApp.myCollection._chmod({hatedGenre: "Dance"}, 0x700, function(response){
		if(err) console.error(err)
	});

---
##File Access##

Hyperyun supports file uploads to the server, where they are stored using [gridfs](http://docs.mongodb.org/manual/core/gridfs/). You add or remove such files using the functions below. Each application has a 'files' collection that can be targetted for queries and retrieval of these files.

###upload (file [, options, callback])###
{: #upload}

Upload a file to be stored on your Hyperyun application server

* __file__: File object to upload to your Hyperyun application.
* __options__: object containing any of the following parameters
	* `folder` - Sets a virtual directory on the server to store the file in.
	* `onWrite` - Function that runs whenever a piece of the file is written to the server. Useful for loading bars. Is given `chunk` as a buffer of bytes.
	* `userData` - An object containing any extra information you would like to associate with this file
* __callback__: Optional function callback. Is passed the following three parameters (res, err, ver):
	* `res` - File info of the uploaded file, including its gridfs_id and metadata, or `null` if an error occurred
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the upload operation on the server

Example:

	//Upload a user's profile picture
	Hyperstore.myApp.upload(myFile, {userData:{user:myUser, date: new Date(), description:"Funny Dog!"}, function(res, err, ver){
		if(!err)
		{
			console.log("Fileuploaded with id = "+response.res.gridfs_id);
			console.log("You can see your picture at <yourapp>.hyperyun.com/static/"+response.res.link);
		} else throw err;
	}})

###removeFile (fileID [, callback])###
{: #removeFile}

//TODO: check return value of gfs.remove()...
Remove a file stored on your Hyperyun application server

* __fileID__: Resource ID of the file to remove from your Hyperyun application. Access the id by retrieving the 'gridfs_id' field from the '<yourapp>_files' document representing the file.
* __callback__: Optional function callback. Is passed the following three parameters (res, err, ver):
	* `res` - True if successful, or `null` if an error occurred
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the removal operation on the server

Example: 

	//Remove a user's profile picture
	Hyperstore.myApp.removeFile(idGridFS, function(res, err, ver){
		if(!err)
		{
			console.log("File successfully removed at "+ver);
		} else throw err;
	})

---
##Events##

Hyperstore provides hooks for common database events, as well as an ability to log to Hyperyun analytics. 

###on (event, function)###
{: #on}

Specify a callback to execute whenever the indicated event occurs. The following events can be hooked into by default: 

	'connect' - When this Hyperstore initially makes contact with the server successfully
	'disconnect' - Whenever this Hyperstore loses connection
	'reconnect' - Whenever this Hyperstore regains connection
	'insert' - Whenever an insert to the collection is detected. Is passed the insert's `selector` as a parameter
	'remove' - Whenever a document is removed from the collection. Is passed the remove's `selector` as a parameter
	'update' - Whenever a document is modified in the collection. Is passed the update's `selector`, `modifier`, and `options` as parameters

* __event__: String name of the event
* __function__: Callback to execute. Is passed a parameter object whose contents depend on the event

Example:

	//Say 'Welcome Back' whenever you reconnect
	Hyperstore.myApp.on('reconnect', function(){
		console.log('Welcome Back!');
	});

###trigger (event [, data])###
{: #trigger}

Manually trigger a callback associated with the event via the `on` method

* __event__: String name of the event
* __data__: Optional. Parameter to pass to the triggered function

Example:

	//Cause a custom event to fire
	Hyperstore.myApp.trigger('myCustomEvent', {myData: "foo"});

###sendAnalyticsEvent (event, time)###

Tell Hyperyun Analytics to log an event

* __event__: Information you wish to log (often just a name String) to Hyperyun Analytics
* __time__: Timestamp of the event

Example:

	//Log that the user has won a game
	Hyperstore.myApp.sendAnalyticsEvent({event: "User won!", user: userID, score: 100}, new Date());

---
##User##

Each Hyperstore connection can connect to your Hyperyun application as one of the application's users, and therefore gain whatever access privileges associated with that user.

###createUser (info [, callback])###
{: #createUser}

Sign-up a new user account for your Hyperyun application.

* __info__: Registration information to create the new account with. Needs to have the following fields
	* `email` - User's sign-up email
	* `login` or `screen_name` - Name to associate with the account
	* `profile` - Object containing any additional information you want to associate with the user
	* `password` - New account password
* __callback__: Optional function callback. Is passed the following three parameters (res, err, ver):
	* `res` - New account's information (omitting their password), or `null` if an error occurred
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the creation action on the server

Example:

	//Make a new account
	Hyperstore.myApp.createUser({email:"foo@bar.com", screen_name:"Master Plan", profile:{age:21, gender:"M",registered:true}, password:"badPassword123"}, function(res, err, ver){
		if(!err)
		{
			console.log("Account created ("+ver+"). Settings: \n"+JSON.stringify(res));
		} else throw err;
	})

###getUser (callback)###
{: #getUser}

Request information about the user currently logged into this Hyperstore object.

* __callback__: Callback to receive the user information. Is passed the user object, or `false` if an error occurred. Is passed either a user object or `false` if an error occurred.

Example:

	//Who am I?
	var me;
	Hyperstore.myApp.getUser(function(user){
		if(user)
		{
			console.log("I am "+JSON.stringify(user));
		} else throw "User inaccessible";
	})

###login (identifier, password [, callback])###
Login into Hyperyun application as a specific user with a username or email.

* __identifier__: String specifying an email associated with the account. If not a valid email, will be interpreted as a username.
* __password__: User password
* __callback__: Optional function callback to perform when the login attempt has completed. Is passed the following three parameters (res, err, ver):
	* `res` - User information, or `null` if an error occurred
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the login attempt on the server

###login (method, data [, callback])###
{: #login}

Log into Hyperyun application as a specific user. If using a third-party authenticator, Hyperstore will bring up a log-in window for that service.

* __method__: String indicating login route to use. Hyperyun supports 'password' login by default, and can support third-party logins if you enable and set them up in your application's administration panel.
	* 'password' - Standard email/password login
	* 'github' - Github OAuth
	* 'facebook' - Facebook OAuth
	* 'weibo' - Weibo OAuth
	* 'google' - Google OAuth
	* 'sina' - Sina OAuth
	* 'twitter' - Twitter OAuth
* __data__: Credentials and options for logging in.
	* `email` - Email associated with the user account (for password method)
	* `password` - User password (for password method)
	* `rememberMe` - Boolean value for maintaining a longer sessinon
	* `scope` - Permissions to request from OAuth provders (for non-password methods)
	* `asAdmin` - Set to 'true' if you want to log in with an admin account (looks at  yourApp_hyperyunAdmin rather than yourApp_users collection for accounts to log in as)
* __callback__: Optional function callback to perform when the login attempt has completed. Is passed the following three parameters (res, err, ver):
	* `res` - User information, or `null` if an error occurred
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the login attempt on the server

Example:

	//Log in with a password
	Hyperstore.myApp.login('password', 
		{
			email: "foo@bar.com",
			password: "badPassword123",
			rememberMe: true
		}, function(res, err, ver){
			if(!err)
			{
				console.log("Logged in ("+ver+"). User: "+JSON.stringify(res));
			} else throw err
	});

###pingLogin (method, data [, callback])###

Attempt a remote-login for this Hyperyun application without associating this hyperstore with that user.

Deprecated: Included for a client.

* __method__: String indicating login route to use. Hyperyun supports 'password' login by default, and can support third-party logins if you enable and set them up in your application's administration panel.
	* 'password' - Standard email/password login
	* 'github' - Github OAuth
	* 'facebook' - Facebook OAuth
	* 'weibo' - Weibo OAuth
	* 'google' - Google OAuth
	* 'sina' - Sina OAuth
	* 'twitter' - Twitter OAuth
* __data__: Credentials and options for logging in.
	* `email` - Email associated with the user account (for password method)
	* `password` - User password (for password method)
	* `rememberMe` - Boolean value for maintaining a longer sessinon
	* `scope` - Permissions to request from OAuth provders (for non-password methods)
	* `asAdmin` - Set to 'true' if you want to log in with an admin account (looks at  yourApp_hyperyunAdmin rather than yourApp_users collection for accounts to log in as)
* __callback__: Optional function callback to perform when the login attempt has completed. Is passed the following three parameters (res, err, ver):
	* `res` - User information, or `null` if an error occurred
	* `err` - Error message (or `false` if no error occurred)
	* `ver` - Timestamp of the login attempt on the server

###logout ([callback])###
{: #logout}

Relinquish the current login session this Hyperstore object has.

* __callback__: Optional function callback to perform once logged out. Is passed the following two parameters (err, ver):
	* `err` - Error Message (or `false` if no error occured)
	* `ver` - Timestamp of server logout time

Example:

	//Log out
	Hyperstore.myApp.logout(function(err, ver){
		if(err)
			console.log(err);
		else
			console.log("Logged out at "+ver)
	});

---
##Account Management##

You can manage user accounts, particularly the administrative tasks associated with passwords, with these Hyperstore methods.

###changePassword (old, new [, callback, forgotPassword])###
{: #changePassword}

Change the current user's account password

* __old__: - The current, valid password of the current user's account
* __new__: - The new, desired password to replace the current password
* __callback__: Optional function callback to perform when the password has changed. Is passed the following three parameters (res, err, ver):
	* `res` - `true` or `false` depending on the validity of the code, or `null` if an error occurred
	* `err` - Error Message (or `false` if no error occurred)
	* `ver` - Timestamp of the password change on the server
* __forgotPassword__: - Optional. If set, the `old:` field is instead expected to be the password reset hashstring generated by a forgotPassword call.

Example:

	//Change my password
	Hyperstore.myApp.changePassword("badPassword123", "4133#qoSiIzz%lD", function(res, err, ver){
		if(!err)
		{
			if(res)
				console.log("Password changed! ("+ver+")");
			else
				console.log("Code/Old Password not valid. Change failed.");
		}
		else throw err;
	});

###activate (code [, callback])###
{: #activate}

Send your Hyperyun application a code to activate an account. This code will have been sent by e-mail to the user.

* __code__: Confirmation string to activate a user account
* __callback__: Optional function callback to perform when the code redemption has completed. Is passed the following three parameters (res, err, ver):
	* `res` - `true` or `false` depending on the validity of the code, or `null` if an error occurred
	* `err` - Error Message (or `false` if no error occurred)
	* `ver` - Timestamp of activation attempt

Example:

	//Activate account associated with an activation code
	Hyperstore.myApp.activate(myCode, function(res,err,ver){
		if(!err)
		{
			if(res)
				console.log("Account activated!");
			else
				console.log("Code invalid. Account not activated");
		}else throw err;
	});

###forgotPassword (email [, callback])###
{: #forgotPassword}

Trigger a password reset email for a user.

* __email__: The address to send the password reset email to
* __callback__: Optional function callback to perform once the reset email has been sent. Is passed the following three parameters (res, err, ver):
	* `res` - The password reset hashstring, or `null` if an error occurred
	* `err` - Error Message (or `false` if no error occurred)
	* `ver` - Timestamp of email's sending

Example:

	//Help a user out
	Hyperstore.myApp.forgotPassword('forgetfullJoe@bar.com', function(res,err,ver){
		if(!err)
		{
			console.log("Reset code (generated at "+ver+"): " + res);
		} else throw err;
	});

---

##Application Management##

Although most application monitoring and management is done via the Hyperyun Administration Panel for your application, there are a few methods available for admin users.

###createApplication (name, url [, callback])###
{: #createApplication}

Register and initialize a new Hyperyun application.

* __name__: Application name String
* __url__: Target url path for application to deploy to, typically 'http://<app_name>.hyperyun.com'
* __callback__: Optional function callback to perform once the application has been created. Is passed the following three parameters (res, err, ver):
	* `res` - Initial application object inserted into database, or `null` if an error occurred
	* `err` - Error Message (or `false` if no error occurred)
	* `ver` - Timestamp of the application creation

Example:

	//Make a birdwatcher application
	Hyperstore.myApp.createApplication('avianPro', 'http://avianPro.hyperyun.com', function(res, err, ver){
		if(!err)
		{
			console.log("Application initialized with "+JSON.stringify(res));
		} else throw err;
	});

###createApplicationWithFirstUser (name, url, firstUser [, callback])###
{: #createApplication}

Register and initialize a new Hyperyun application, adding a first user to the `users` collection

* __name__: Application name String
* __url__: Target url path for application to deploy to, typically 'http://<app_name>.hyperyun.com'
* __firstUser__: JSON object with the information needed for a `createUser` call
	* `email` - User's sign-up email
	* `login` or `screen_name` - Name to associate with the account
	* `profile` - Object containing any additional information you want to associate with the user
	* `password` - New account password
* __callback__: Optional function callback to perform once the application has been created. Is passed the following three parameters (res, err, ver):
	* `res` - Initial application object inserted into database, or `null` if an error occurred
	* `err` - Error Message (or `false` if no error occurred)
	* `ver` - Timestamp of the application creation

Example:

	//Make a birdwatcher application
	Hyperstore.myApp.createApplication('avianPro', 'http://avianPro.hyperyun.com', {email:"example@example.com", screen_name:"test",password:"testpassword"} function(res, err, ver){
		if(!err)
		{
			console.log("Application initialized with "+JSON.stringify(res));
		} else throw err;
	});

###generateAPIKey (appName [, callback])###
{: #generateAPIKey}

Create or regenerate the admin-level API key for the RESTful interface to your Hyperyun application.

* __appName__: The application identifier to regenerate the API key
* __callback__: Optional function callback to perform once a new API key has been created. Is passed the following three parameters (res, err, ver):
	* `res` - Object containing the key and access level of the API key
	* `err` - Error Message (or `false` if no error occurred)
	* `ver` - Timestamp of the generation request

Example:

	//Regenerate your application's key
	Hyperstore.myApp.generateAPIKey('avianpro', function(res,err,ver){
		if(!err)
		{
			console.log("Generated new key ("+res+") at "+ver);
		} else throw err;
	});

###getCurrentPopulation (callback)###
{: #getCurrentPopulation}

Get the number of users (logged in or not) connected to your application.

* __callback__: Function to be called once the number of users is known. Is passed the following three parameters (res, err, ver):
	* `res` - An integer counting the number of active users
	* `err` - Error Message (or `false` if no error occurred)
	* `ver` - Timestamp of the user count

Example:

	var headcount;
	Hyperstore.myApp.getCurrentPopulation(function(res,err,ver){
		if(!err)
		{
			headcount = res;
		} else throw err;
	});

---

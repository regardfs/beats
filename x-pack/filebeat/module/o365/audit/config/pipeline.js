// Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
// or more contributor license agreements. Licensed under the Elastic License;
// you may not use this file except in compliance with the Elastic License.

var processor = require("processor");
var console   = require("console");


// PipelineBuilder to aid debugging of pipelines during development.
function PipelineBuilder(pipelineName, debug) {
    this.pipeline = new processor.Chain();
    this.add = function (processor) {
        this.pipeline = this.pipeline.Add(processor);
    };
    this.Add = function (name, processor) {
        this.add(processor);
        if (debug) {
            this.add(makeLogEvent("after " + pipelineName + "/" + name));
        }
    };
    this.Build = function () {
        if (debug) {
            this.add(makeLogEvent(pipelineName + "processing done"));
        }
        return this.pipeline.Build();
    };
    if (debug) {
        this.add(makeLogEvent(pipelineName + ": begin processing event"));
    }
}

// logEvent(msg)
//
// Processor that logs the current value of evt to console.debug.
function makeLogEvent(msg) {
    return function (evt) {
        console.debug(msg + " :" +  JSON.stringify(evt, null, 4));
    };
}

// makeConditional({condition:expr, result1:processor|expr, [...]})
//
// Processor that selects which processor to run depending on the result of
// evaluating a _condition_. Result can be boolean (if-else equivalent) or any
// other value (switch equivalent). Unspecified values are a no-op.
function makeConditional(options) {
    return function (evt) {
        var branch = options[options.condition(evt)] || function(evt){};
        return (typeof branch === "function" ? branch : branch.Run)(evt);
    };
}

// makeMapper({from:field, to:field, default:value mappings:{orig: new, [...]}})
//
// Processor that sets _to_ field from a mapping of _from_ field's value.
function makeMapper(options) {
    return function (evt) {
        var key = evt.Get(options.from);
        if (key == null && options.skip_missing) return;
        if (options.lowercase && typeof key == "string") {
            key = key.toLowerCase();
        }
        var value = options.default;
        if (key in options.mappings) {
            value = options.mappings[key];
        } else if (typeof value === "function") {
            value = value(key);
        }
        if (value != null) {
            evt.Put(options.to, value);
        }
    };
}

function validFieldName(s) {
    // Remove spaces and dots from keys.
    return s.replace(/[\ \.]/g, '_')
}

function makeDictFromKVArray(options) {
    return function(evt) {
        var src = evt.Get(options.from);
        var dict = {};
        if (src == null || !(src instanceof Array)) return;
        for (var i=0; i < src.length; i++) {
            var name, value;
            if (src[i] == null
                || (name=src[i].Name) == null
                || (value=src[i].Value) == null) continue;
            name = validFieldName(name);
            if (name in dict) {
                if (dict[name] instanceof Array) {
                    dict[name].push(value);
                } else {
                    dict[name] = [value];
                }
            } else {
                dict[name] = value;
            }
        }
        evt.Put(options.to, dict);
    }
}

function makeDictFromModifiedPropertyArray(options) {
    return function(evt) {
        var src = evt.Get(options.from);
        var dict = {};
        if (src == null || !(src instanceof Array)) return;
        for (var i=0; i < src.length; i++) {
            var name, newValue, oldValue;
            if (src[i] == null
                || (name=src[i].Name) == null
                || (newValue=src[i].NewValue) == null
                || (oldValue=src[i].OldValue)) continue;
            name = validFieldName(name);
            if (name in dict) {
                if (dict[name].NewValue instanceof Array) {
                    dict[name].NewValue.push(newValue);
                    dict[name].OldValue.push(oldValue);
                } else {
                    dict[name].NewValue = [newValue];
                    dict[name].OldValue = [oldValue];
                }
            } else {
                dict[name] = {
                    NewValue: newValue,
                    OldValue: oldValue,
                };
            }
        }
        evt.Put(options.to, dict);
    }
}

function exchangeAdminSchema(debug) {
    var builder = new PipelineBuilder("o365.audit.ExchangeAdmin", debug);
    builder.Add("saveFields", new processor.Convert({
        fields: [
            {from: 'o365audit.OrganizationName', to: 'organization.name'},
            {from: 'o365audit.OriginatingServer', to: 'server.address'},
        ],
        ignore_missing: true,
        fail_on_error: false
    }));
    return builder.Build();
}

function azureADLogonSchema(debug) {
    var builder = new PipelineBuilder("o365.audit.AzureActiveDirectory", debug);
    builder.Add("setEventAuthFields", function(evt){
       evt.Put("event.category", "authentication");
       var outcome = evt.Get("event.outcome");
       var types = ["start"];
       if (outcome != null && outcome !== "unknown") {
           // As event.type is an array, this sets both the traditional
           // "authentication_success"/"authentication_failure"
           // and the soon to be ECS standard "start".
           types.push("authentication_" + outcome);
       }
       evt.Put("event.type", types);
    });
    return builder.Build();
}

function sharePointFileOperationSchema(debug) {
    var builder = new PipelineBuilder("o365.audit.SharePointFileOperation", debug);
    builder.Add("saveFields", new processor.Convert({
        fields: [
            {from: 'o365audit.ObjectId', to: 'url.original'},
            {from: 'o365audit.SourceRelativeUrl', to: 'file.directory'},
            {from: 'o365audit.SourceFileName', to: 'file.name'},
            {from: 'o365audit.SourceFileExtension', to: 'file.extension'},
        ],
        ignore_missing: true,
        fail_on_error: false
    }));
    builder.Add("setEventCategory", new processor.AddFields({
        target: 'event',
        fields: {
            category: 'file',
        },
    }));
    builder.Add("mapEventType", makeMapper({
        from: 'o365audit.Operation',
        to: 'event.type',
        mappings: {
            'FileAccessed': 'access',
            'FileDeleted': 'deletion',
            'FileDownloaded': 'access',
            'FileModified': 'change',
            'FileMoved': 'change',
            'FileRenamed': 'change',
            'FileRestored': 'change',
            'FileUploaded': 'creation',
            'FolderCopied': 'creation',
            'FolderCreated': 'creation',
            'FolderDeleted': 'deletion',
            'FolderModified': 'change',
            'FolderMoved': 'change',
            'FolderRenamed': 'change',
            'FolderRestored': 'change',
        },
    }));
    return builder.Build();
}

function exchangeMailboxSchema(debug) {
    var builder = new PipelineBuilder("o365.audit.SharePointFileOperation", debug);
    builder.Add("saveFields", new processor.Convert({
        fields: [
            {from: 'o365audit.MailboxOwnerUPN', to: 'user.email'},
            {from: 'o365audit.LogonUserSid', to: 'user.id'},
            {from: 'o365audit.LogonUserDisplayName', to: 'user.full_name'},
            {from: 'o365audit.OrganizationName', to: 'organization.name'},
            {from: 'o365audit.OriginatingServer', to: 'server.address'},
            {from: 'o365audit.ClientIPAddress', to: 'client.address'},
            {from: 'o365audit.ClientProcessName', to: 'process.name'},
        ],
        ignore_missing: true,
        fail_on_error: false
    }));
    return builder.Build();
}

function dataLossPreventionSchema(debug) {
    var builder = new PipelineBuilder("o365.audit.DLP", debug);
    builder.Add("setEventKind", new processor.AddFields({
        target: 'event',
        fields: {
            kind: 'alert',
            category: 'file',
            type: 'access',
        },
    }));
    builder.Add("saveFields", new processor.Convert({
        fields: [
            // SharePoint metadata
            {from: 'o365audit.SharePointMetaData.From', to: 'user.id'},
            {from: 'o365audit.SharePointMetaData.FileName', to: 'file.name'},
            {from: 'o365audit.SharePointMetaData.FilePathUrl', to: 'url.original'},
            {from: 'o365audit.SharePointMetaData.UniqueId', to: 'file.inode'},
            {from: 'o365audit.SharePointMetaData.UniqueID', to: 'file.inode'},
            {from: 'o365audit.SharePointMetaData.FileOwner', to: 'file.owner'},

            // Exchange metadata
            {from: 'o365audit.ExchangeMetaData.From', to: 'source.user.email'},
            {from: 'o365audit.ExchangeMetaData.Subject', to: 'message'},

            // Policy details
            {from: 'o365audit.PolicyId', to: 'rule.id'},
            {from: 'o365audit.PolicyName', to: 'rule.name'},
        ],
        ignore_missing: true,
        fail_on_error: false
    }));
    builder.Add("setMTime", new processor.Timestamp({
        field: "o365audit.SharePointMetaData.LastModifiedTime",
        target_field: "file.mtime",
        layouts: [
            "2006-01-02T15:04:05",
            "2006-01-02T15:04:05Z",
        ],
        ignore_missing: true,
        ignore_failure: true,
    }));
    builder.Add("appendDestinationEmails", function(evt) {
       var list = [];
       var fields = [
           'o365audit.ExchangeMetaData.To',
           'o365audit.ExchangeMetaData.CC',
           'o365audit.ExchangeMetaData.BCC',
       ];
       for (var i=0; i<fields.length; i++) {
           var value = evt.Get(fields[i]);
           if (value == null) continue;
           if (value instanceof Array) {
               list = list.concat(value);
           } else {
               list.push(value);
           }
       }
       if (list.length == 1) {
           evt.Put("destination.user.email", list[0]);
       } else if (list.length > 1) {
           evt.Put("destination.user.email", list);
       }
    });
    // ExceptionInfo is documented as string but has been observed to be an object.
    builder.Add("fixExceptionInfo", function(evt) {
        var key = "o365audit.ExceptionInfo";
        var eInfo = evt.Get(key);
        if (eInfo == null) return;
        if (typeof eInfo === "string") {
            if (eInfo === "") {
                evt.Delete(key);
            } else {
                evt.Put(key, {
                    Reason: eInfo,
                });
            }
        }
    });
    builder.Add("extractRules", function(evt) {
        var policies = evt.Get("o365audit.PolicyDetails");
        if (policies == null) return;
        var ruleIds = [];
        var ruleNames = [];
        var maxSeverity = -1;
        var allowed = true;
        for (var i = 0; i < policies.length; i++) {
            var rules = policies[i].Rules;
            if (rules == null) continue;
            for (var j = 0; j < rules.length; j++) {
                var rule = rules[j];
                var id = rule.RuleId;
                var name = rule.RuleName;
                var sev = severityToCode(rule.Severity);
                if (id != null && name != null) {
                    ruleIds.push(id);
                    ruleNames.push(name);
                }
                if (sev > maxSeverity) maxSeverity = sev;
                if (allowed) {
                    if (rule.Actions != null && rule.Actions.indexOf("BlockAccess") > -1) {
                        allowed = false;
                    }
                }
            }
        }
        if (ruleIds.length === 1) {
            evt.Put("rule.id", ruleIds[0]);
            evt.Put("rule.name", ruleNames[0]);
        } else if (ruleIds.length > 0) {
            evt.Put("rule.id", ruleIds);
            evt.Put("rule.name", ruleNames);
        }
        if (maxSeverity > -1) {
            evt.Put("event.severity", maxSeverity);
        }
        if (allowed) {
            evt.Put("event.outcome", "success");
        } else {
            evt.Put("event.outcome", isBlockOverride(evt)? "success" : "failure");
        }
    });
    return builder.Build();
}

function severityToCode(str) {
    if (str == null) return -1;
    switch (str.toLowerCase()) {
        case '': return -1;
        case 'informational': return 1;
        case 'low': return 2;
        case 'medium': return 3;
        case 'high': return 4;
        default: return 5;
    }
}

function isBlockOverride(evt) {
    switch (evt.Get("o365audit.Operation")) {
        // Undo means the block was undone via change of policy or override.
        case "DlpRuleUndo":
        case "DLPRuleUndo": return true;
        // Info means it was detected as a false positive but no action taken.
        case "DlpInfo":
        case "DLPInfo": return false;
    }
    // It's not clear to me the format of ExceptionInfo. It could be an object
    // or a string containing a JSON object. Assume that if present, an exception
    // is made.
    var exInfo = evt.Get('o365audit.ExceptionInfo');
    return exInfo != null && exInfo !== "";
}

function yammerSchema(debug) {
    var builder = new PipelineBuilder("o365.audit.Yammer", debug);
    builder.Add("saveFields", new processor.Convert({
        fields: [
            {from: 'o365audit.ActorUserId', to: 'user.email'},
            {from: 'o365audit.ActorYammerUserId', to: 'user.id'},
            {from: 'o365audit.FileId', to:'file.inode'},
            {from: 'o365audit.FileName', to: 'file.name'},
            {from: 'o365audit.GroupName', to: 'group.name'},
            {from: 'o365audit.TargetUserId', to: 'destination.user.email'},
            {from: 'o365audit.TargetYammerUserId', to: 'destination.user.id'},
        ],
        ignore_missing: true,
        fail_on_error: false
    }));
    builder.Add("setEventFields", new processor.AddFields({
        target: 'event',
        fields: {
            category: 'file',
        },
        'when.equals.o365audit.DataExportTime': 'data',
    }));
    return builder.Build();
}

function securityComplianceAlertsSchema(debug) {
    var builder = new PipelineBuilder("o365.audit.SecurityComplianceAlerts", debug);
    builder.Add("saveFields", new processor.Convert({
        fields: [
            {from: 'o365audit.Comments', to: 'message'},
            {from: 'o365audit.Name', to: 'rule.name'},
            {from: 'o365audit.PolicyId', to: 'rule.id'},
            {from: 'o365audit.Category', to: 'rule.category'},
            {from: 'o365audit.EntityType', to: 'rule.ruleset'},
            // This contains the entity that triggered the alert.
            // Name of a malware or email address.
            // Need to find a better ECS field for it.
            {from: 'o365audit.AlertEntityId', to: 'rule.description'},
            {from: 'o365audit.AlertLinks', to: 'rule.reference'},
        ],
        ignore_missing: true,
        fail_on_error: false
    }));
    builder.Add("setEventKind", new processor.AddFields({
        target: 'event',
        fields: {
            kind: 'alert',
            category: 'web',
            type: 'info',
        },
    }));
    // event.severity is numeric.
    builder.Add("mapSeverity", function(evt) {
       var sev = severityToCode(evt.Get("o365audit.Severity"));
       if (sev >= 0) {
           evt.Put("event.severity", sev);
       }
    });
    builder.Add("mapCategory", makeMapper({
        from: 'o365audit.Category',
        to: 'event.category',
        default: 'authentication',
        lowercase: true,
        mappings: {
            'accessgovernance': 'authentication',
            'datagovernance': 'file',
            'datalossprevention': 'file',
            'threatmanagement': 'malware',
        },
    }));
    builder.Add("saveEntity", makeConditional({
        condition: function(evt) {
            return evt.Get("o365audit.EntityType");
        },
        'User': new processor.Convert({
            fields: [
                {from: "o365audit.AlertEntityId", to: "user.id"},
            ],
            ignore_missing: true,
            fail_on_error: false
        }),
        'Recipients': new processor.Convert({
            fields: [
                {from: "o365audit.AlertEntityId", to: "user.email"},
            ],
            ignore_missing: true,
            fail_on_error: false
        }),
        'Sender': new processor.Convert({
            fields: [
                {from: "o365audit.AlertEntityId", to: "user.email"},
            ],
            ignore_missing: true,
            fail_on_error: false
        }),
        'MalwareFamily': new processor.Convert({
            fields: [
                {from: "o365audit.AlertEntityId", to: "threat.technique.id"},
            ],
            ignore_missing: true,
            fail_on_error: false
        }),
    }));
    return builder.Build();
}

function AuditProcessor(debug) {
    var builder = new PipelineBuilder("o365.audit", debug);

    builder.Add("cleanupNulls", function(event) {
        [
            "o365audit.ClientIP",
            "o365audit.ClientIPAddress",
            "o365audit.ActorIpAddress"
        ].forEach(function(field) {
            var value = event.Get(field);
            if (value === "null" || value === "<null>") {
                event.Delete(field);
            }
        })
    });
    builder.Add("convertCommonAuditRecordFields", new processor.Convert({
        fields: [
            {from: "o365audit.Id", to: "event.id"},
            {from: "o365audit.ClientIP", to: "client.address"},
            {from: "o365audit.ClientIPAddress", to: "client.address"},
            {from: "o365audit.ActorIpAddress", to: "client.address"},
            {from: "o365audit.UserKey", to: "user.hash"},
            {from: "o365audit.UserId", to: "user.id"},
            {from: "o365audit.Workload", to: "event.provider"},
            {from: "o365audit.Operation", to: "event.action"},
            {from: "o365audit.OrganizationId", to: "organization.id"},
            // Extra common fields:
            {from: "o365audit.UserAgent", to: "user_agent.original"},
        ],
        ignore_missing: true,
        fail_on_error: false
    }));
    builder.Add("mapEventType", makeMapper({
        from: 'o365audit.RecordType',
        to: 'event.code',
        // Keep recordType for unknown mappings.
        default: function(recordType) {
            return recordType;
        },
        mappings: {
            1: 'ExchangeAdmin', // Events from the Exchange admin audit log.
            2: 'ExchangeItem', // Events from an Exchange mailbox audit log for actions that are performed on a single item, such as creating or receiving an email message.
            3: 'ExchangeItemGroup', // Events from an Exchange mailbox audit log for actions that can be performed on multiple items, such as moving or deleted one or more email messages.
            4: 'SharePoint', // SharePoint events.
            6: 'SharePointFileOperation', // SharePoint file operation events.
            8: 'AzureActiveDirectory', // Azure Active Directory events.
            9: 'AzureActiveDirectoryAccountLogon', // Azure Active Directory OrgId logon events (deprecating).
            10: 'DataCenterSecurityCmdlet', // Data Center security cmdlet events.
            11: 'ComplianceDLPSharePoint', // Data loss protection (DLP) events in SharePoint and OneDrive for Business.
            12: 'Sway', // Events from the Sway service and clients.
            13: 'ComplianceDLPExchange', // Data loss protection (DLP) events in Exchange, when configured via Unified DLP Policy. DLP events based on Exchange Transport Rules are not supported.
            14: 'SharePointSharingOperation', // SharePoint sharing events.
            15: 'AzureActiveDirectoryStsLogon', // Secure Token Service (STS) logon events in Azure Active Directory.
            18: 'SecurityComplianceCenterEOPCmdlet', // Admin actions from the Security & Compliance Center.
            20: 'PowerBIAudit', // Power BI events.
            21: 'CRM', // Microsoft CRM events.
            22: 'Yammer', // Yammer events.
            23: 'SkypeForBusinessCmdlets', // Skype for Business events.
            24: 'Discovery', // Events for eDiscovery activities performed by running content searches and managing eDiscovery cases in the Security & Compliance Center.
            25: 'MicrosoftTeams', // Events from Microsoft Teams.
            28: 'ThreatIntelligence', // Phishing and malware events from Exchange Online Protection and Office 365 Advanced Threat Protection.
            30: 'MicrosoftFlow', // Microsoft Power Automate (formerly called Microsoft Flow) events.
            31: 'AeD', // Advanced eDiscovery events.
            32: 'MicrosoftStream', // Microsoft Stream events.
            33: 'ComplianceDLPSharePointClassification', // Events related to DLP classification in SharePoint.
            35: 'Project', // Microsoft Project events.
            36: 'SharePointListOperation', // SharePoint List events.
            38: 'DataGovernance', // Events related to retention policies and retention labels in the Security & Compliance Center
            40: 'SecurityComplianceAlerts', // Security and compliance alert signals.
            41: 'ThreatIntelligenceUrl', // Safe links time-of-block and block override events from Office 365 Advanced Threat Protection.
            42: 'SecurityComplianceInsights', // Events related to insights and reports in the Office 365 security and compliance center.
            44: 'WorkplaceAnalytics', // Workplace Analytics events.
            45: 'PowerAppsApp', // Power Apps events.
            47: 'ThreatIntelligenceAtpContent', // Phishing and malware events for files in SharePoint, OneDrive for Business, and Microsoft Teams from Office 365 Advanced Threat Protection.
            49: 'TeamsHealthcare', // Events related to the Patients application in Microsoft Teams for Healthcare.
            52: 'DataInsightsRestApiAudit', // Data Insights REST API events.
            54: 'SharePointListItemOperation', // SharePoint list item events.
            55: 'SharePointContentTypeOperation', // SharePoint list content type events.
            56: 'SharePointFieldOperation', // SharePoint list field events.
            64: 'AirInvestigation', // Automated incident response (AIR) events.
            66: 'MicrosoftForms', // Microsoft Forms events.
        },
    }));
    builder.Add("setEventFields", new processor.AddFields({
        target: 'event',
        fields: {
            kind: 'event',
            type: 'info',
            // Not so sure about web as a default category:
            category: 'web',
        },
    }));
    builder.Add("mapEventOutcome", makeMapper({
        from: 'o365audit.ResultStatus',
        to: 'event.outcome',
        lowercase: true,
        default: 'success',
        mappings: {
            'success': 'success', // This one is necessary to map Success
            'succeeded': 'success',
            'partiallysucceeded': 'success',
            'true': 'success',
            'failed': 'failure',
            'false': 'failure',
        },
    }));
    builder.Add("makeParametersDict", makeDictFromKVArray({
        from: 'o365audit.Parameters',
        to: 'o365audit.Parameters',
    }));
    builder.Add("makeExtendedPropertiesDict", makeDictFromKVArray({
        from: 'o365audit.ExtendedProperties',
        to: 'o365audit.ExtendedProperties',
    }));
    builder.Add("makeModifiedPropertyDict", makeDictFromModifiedPropertyArray({
        from: 'o365audit.ModifiedProperties',
        to: 'o365audit.ModifiedProperties',
    }));
    // Turn AlertLinks into an (optional array of) keyword instead of array
    // of objects.
    builder.Add("alertLinks", function (evt) {
        var list = evt.Get("o365audit.AlertLinks");
        if (list == null || !(list instanceof Array)) return;
        var links = [];
        for (var i=0; i<list.length; i++) {
            var link = list[i].AlertLinkHref;
            if (link != null && typeof link === "string" && link.length > 0) {
                links.push(link);
            }
        }
        switch (links.length) {
            case 0:
                evt.Delete('o365audit.AlertLinks');
                break;
            case 1:
                evt.Put("o365audit.AlertLinks", links[0]);
                break;
            default:
                evt.Put("o365audit.AlertLinks", links);
        }
    });
    // Populate event specific fields.
    var dlp = dataLossPreventionSchema(debug);
    builder.Add("productSpecific", makeConditional({
        condition: function(event) {
            return event.Get("event.code");
        },
        'ExchangeAdmin': exchangeAdminSchema(debug).Run,
        'ExchangeItem': exchangeMailboxSchema(debug).Run,
        'AzureActiveDirectoryStsLogon': azureADLogonSchema(debug).Run,
        'SharePointFileOperation': sharePointFileOperationSchema(debug).Run,
        'SecurityComplianceAlerts': securityComplianceAlertsSchema(debug).Run,
        'ComplianceDLPSharePoint': dlp.Run,
        'ComplianceDLPExchange': dlp.Run,
        'Yammer': yammerSchema(debug).Run,
    }));

    // Copy the client/server.address to ip fields if they are valid IP addresses.
    builder.Add("copyClientServerFields", new processor.Convert({
        fields: [
            {from: "client.address", to: "client.ip", type: "ip"},
            {from: "server.address", to: "server.ip", type: "ip"},
        ],
        ignore_missing: true,
        fail_on_error: false
    }));
    builder.Add("copySrcDstFields", new processor.Convert({
        fields: [
            {from: "client.ip", to: "source.ip"},
            {from: "server.ip", to: "destination.ip"},
        ],
        ignore_missing: true,
        fail_on_error: false
    }));
    builder.Add("setUserFieldsFromId", new processor.Dissect({
        tokenizer: "%{name}@%{domain}",
        field: "user.id",
        target_prefix: "user",
        'when.contains.user.id': '@',
    }));
    builder.Add("setNetworkType", function(event) {
        var ip = event.Get("client.ip");
        if (ip == null) return;
        event.Put("network.type", ip.indexOf(".") !== -1? "ipv4" : "ipv6");
    });

    builder.Add("setRelatedIP", function(event) {
        ["client.ip", "server.ip"].forEach(function(field) {
            var val = event.Get(field);
            if (val) {
                event.AppendTo("related.ip", val);
            }
        });
    });

    // Set user-agent
    builder.Add("altUserAgent", function(evt) {
        var ext = evt.Get("o365audit.ExtendedProperties.UserAgent");
        if (ext != null) evt.Put("user_agent.original", ext);
    });

    // Set host.name to the O365 tenant. This is necessary to aggregate events
    // in SIEM app based on the tenant instead of the host where Filebeat is
    // running.
    builder.Add("setHostName", function(evt) {
        var value;
        if ((value=evt.Get("organization.id"))!=null) {
            value = value.toLowerCase();
            evt.Put("host.id", value);
            // Use tenant name provided in the configuration.
            if (value in tenant_names && value !== "") {
                evt.Put("organization.name", value);
                evt.Put("host.name", tenant_names[value]);
                return;
            }
        }
        if ((value=evt.Get("organization.name"))!=null ||
            (value=evt.Get("user.domain")) != null ) {
            evt.Put("host.name", value);
        }
    });

    var chain = builder.Build();
    return {
        process: chain.Run
    };
}


var audit;
var tenant_names = {};

// Register params from configuration.
function register(params) {
    if (params.tenants != null) {
        for (var i = 0; i < params.tenants.length; i++) {
            tenant_names[params.tenants[i].id] = params.tenants[i].name.toLowerCase();
        }
    }
    audit = new AuditProcessor(params.debug);
}

function process(evt) {
    return audit.process(evt);
}
